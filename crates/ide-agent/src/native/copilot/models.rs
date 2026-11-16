//! Model catalog, effort levels, context-window tiers, and token pricing from
//! `copilot --headless --stdio` (`models.list` + `models.listTokenPriceUnits`).

use crate::model::{AgentModelPricing, AgentTokenPricing};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

pub(super) const MODEL: &str = "model";
pub(super) const EFFORT: &str = "reasoning_effort";
pub(super) const CONTEXT_TIER: &str = "context_tier";
pub(super) const MODE: &str = "mode";
pub(super) const ALLOW_ALL: &str = "allow_all";

const BATCH_TOKENS: f64 = 1_000_000.0;
const NANO_AIU_PER_CREDIT: f64 = 1_000_000_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Agent,
    Plan,
    Autopilot,
}

impl Mode {
    pub const ALL: [Mode; 3] = [Mode::Agent, Mode::Plan, Mode::Autopilot];

    pub fn id(self) -> &'static str {
        match self {
            Mode::Agent => "agent",
            Mode::Plan => "plan",
            Mode::Autopilot => "autopilot",
        }
    }

    pub fn wire(self) -> &'static str {
        match self {
            Mode::Agent => "interactive",
            Mode::Plan => "plan",
            Mode::Autopilot => "autopilot",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Mode::Agent => "Agent",
            Mode::Plan => "Plan",
            Mode::Autopilot => "Autopilot",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Mode::Agent => "Default agent mode for conversational interactions",
            Mode::Plan => "Plan mode for creating and executing multi-step plans",
            Mode::Autopilot => "Autonomous mode that enables allow-all and runs until task completion",
        }
    }

    pub fn parse(value: &str) -> Option<Mode> {
        let short = value.rsplit(['#', '/']).next().unwrap_or(value);
        match short {
            "agent" | "interactive" => Some(Mode::Agent),
            "plan" => Some(Mode::Plan),
            "autopilot" => Some(Mode::Autopilot),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct ContextTierChoice {
    pub id: &'static str,
    pub label: String,
    pub tokens: u32,
    pub description: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct ModelEntry {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub is_default: bool,
    pub default_effort: Option<String>,
    pub efforts: Vec<String>,
    pub context_tiers: Vec<ContextTierChoice>,
    pub default_context_tokens: Option<u32>,
    pub max_context_tokens: Option<u32>,
    pub pricing: Option<AgentModelPricing>,
}

impl ModelEntry {
    /// Copilot's default reasoning effort for this model: user setting (`effortLevel`) when
    /// supported, otherwise the model's `defaultReasoningEffort`, `"medium"`, or first listed.
    pub fn default_effort<'a>(&'a self, user_default: Option<&str>) -> Option<&'a str> {
        if let Some(wanted) = user_default
            && let Some(found) = self.efforts.iter().find(|e| e.as_str() == wanted)
        {
            return Some(found.as_str());
        }
        if let Some(model_def) = self.default_effort.as_deref()
            && let Some(found) = self.efforts.iter().find(|e| e.as_str() == model_def)
        {
            return Some(found.as_str());
        }
        self.efforts.iter().find(|e| e.as_str() == "medium").or_else(|| self.efforts.first()).map(String::as_str)
    }

    /// Copilot's default context-window tier for this model: user setting (`contextTier`) when
    /// supported, otherwise `"default"` (`200K`), or first listed.
    pub fn default_context_tier(&self, user_default: Option<&str>) -> Option<&'static str> {
        if let Some(wanted) = user_default
            && let Some(found) = self.context_tiers.iter().find(|t| t.id == wanted)
        {
            return Some(found.id);
        }
        self.context_tiers.iter().find(|t| t.id == "default").or_else(|| self.context_tiers.first()).map(|t| t.id)
    }

    /// Active context window capacity in tokens for `tier`.
    pub fn context_tokens(&self, tier: Option<&str>) -> Option<u32> {
        if let Some(tier) = tier
            && let Some(found) = self.context_tiers.iter().find(|t| t.id == tier)
        {
            return Some(found.tokens);
        }
        self.context_tiers
            .iter()
            .find(|t| t.id == "default")
            .or_else(|| self.context_tiers.first())
            .map(|t| t.tokens)
            .or(self.default_context_tokens)
            .or(self.max_context_tokens)
    }
}

/// Copilot's own configured defaults from `user.settings.get` (`~/.copilot/config.json`)
/// and optional CLI launch flags (`--model`, `--effort`, `--context`, `--allow-all`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct UserDefaults {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub context_tier: Option<String>,
    pub mode: Option<Mode>,
    pub allow_all: Option<bool>,
}

impl UserDefaults {
    pub fn from_rpc_and_args(settings_rpc: Option<&Value>, args: &[String]) -> Self {
        let mut out = Self::default();
        if let Some(res) = settings_rpc {
            out.model = setting_str(res, "model");
            out.effort = setting_str(res, "effortLevel").or_else(|| setting_str(res, "reasoningEffort"));
            out.context_tier = setting_str(res, "contextTier");
            out.mode = setting_str(res, "defaultMode").and_then(|m| Mode::parse(&m));
            out.allow_all = setting_str(res, "defaultPermissionMode").and_then(|p| match p.as_str() {
                "allow-all" | "allow_all" | "bypass" | "autopilot" => Some(true),
                "manual" => Some(false),
                _ => None,
            });
        }
        let mut iter = args.iter().peekable();
        while let Some(arg) = iter.next() {
            let s = arg.as_str();
            if s == "--allow-all" || s == "--yolo" {
                out.allow_all = Some(true);
            } else if let Some(v) = flag_val(s, "--model", &mut iter) {
                out.model = Some(v);
            } else if let Some(v) =
                flag_val(s, "--effort", &mut iter).or_else(|| flag_val(s, "--reasoning-effort", &mut iter))
            {
                out.effort = Some(v);
            } else if let Some(v) = flag_val(s, "--context", &mut iter) {
                out.context_tier = Some(v);
            }
        }
        out
    }
}

fn setting_str(res: &Value, key: &str) -> Option<String> {
    let settings = res.get("settings");
    let raw = settings
        .and_then(|s| s.get(key))
        .and_then(|entry| entry.get("value").or(Some(entry)))
        .or_else(|| res.get(key))?;
    raw.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn flag_val<'a>(
    arg: &'a str,
    flag: &str,
    iter: &mut std::iter::Peekable<std::slice::Iter<'a, String>>,
) -> Option<String> {
    if arg == flag {
        return iter.next().map(|v| v.trim()).filter(|v| !v.is_empty()).map(str::to_owned);
    }
    let prefix = format!("{flag}=");
    arg.strip_prefix(&prefix).map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned)
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Settings {
    pub model: String,
    pub effort: Option<String>,
    pub context_tier: Option<String>,
    pub mode: Mode,
    pub allow_all: bool,
    defaults: UserDefaults,
    /// Explicit per-session user overrides; `None` means track Copilot's default for each model.
    explicit_effort: Option<String>,
    explicit_context_tier: Option<String>,
}

impl Settings {
    pub fn new(models: &[ModelEntry], defaults: &UserDefaults) -> Self {
        let model = defaults
            .model
            .as_deref()
            .filter(|id| models.iter().any(|m| m.id == *id))
            .or_else(|| models.iter().find(|m| m.is_default && m.id != "auto").map(|m| m.id.as_str()))
            .or_else(|| models.iter().find(|m| m.id != "auto").map(|m| m.id.as_str()))
            .or_else(|| models.first().map(|m| m.id.as_str()))
            .unwrap_or("auto")
            .to_owned();
        let mode = defaults.mode.unwrap_or(Mode::Agent);
        let allow_all = defaults.allow_all.unwrap_or(false) || mode == Mode::Autopilot;
        let mut s = Self {
            model,
            effort: None,
            context_tier: None,
            mode,
            allow_all,
            defaults: defaults.clone(),
            explicit_effort: None,
            explicit_context_tier: None,
        };
        s.fit_to_model(models);
        s
    }

    pub fn fit_to_model(&mut self, models: &[ModelEntry]) {
        let Some(m) = models.iter().find(|m| m.id == self.model) else {
            self.effort = None;
            self.context_tier = None;
            return;
        };
        self.effort = if m.efforts.is_empty() {
            None
        } else if let Some(wanted) = self.explicit_effort.as_deref().filter(|w| m.efforts.iter().any(|e| e == *w)) {
            Some(wanted.to_owned())
        } else {
            m.default_effort(self.defaults.effort.as_deref()).map(str::to_owned)
        };

        self.context_tier = if m.context_tiers.is_empty() {
            None
        } else if let Some(wanted) =
            self.explicit_context_tier.as_deref().filter(|w| m.context_tiers.iter().any(|t| t.id == *w))
        {
            Some(wanted.to_owned())
        } else {
            m.default_context_tier(self.defaults.context_tier.as_deref()).map(str::to_owned)
        };
    }

    pub fn set(&mut self, models: &[ModelEntry], option: &str, value: &str) -> Result<(), String> {
        match option {
            MODEL => {
                if !models.is_empty() && !models.iter().any(|m| m.id == value) && value != self.model {
                    return Err(format!("unknown model {value}"));
                }
                self.model = value.to_owned();
                self.fit_to_model(models);
            }
            EFFORT => {
                let m = models.iter().find(|m| m.id == self.model);
                if !m.is_some_and(|m| m.efforts.iter().any(|e| e == value)) {
                    return Err(format!("{} has no reasoning effort {value}", self.model));
                }
                self.effort = Some(value.to_owned());
                self.explicit_effort = Some(value.to_owned());
            }
            CONTEXT_TIER => {
                let m = models.iter().find(|m| m.id == self.model);
                if !m.is_some_and(|m| m.context_tiers.iter().any(|t| t.id == value)) {
                    return Err(format!("{} has no context tier {value}", self.model));
                }
                self.context_tier = Some(value.to_owned());
                self.explicit_context_tier = Some(value.to_owned());
            }
            MODE => {
                let mode = Mode::parse(value).ok_or_else(|| format!("unknown mode {value}"))?;
                self.mode = mode;
                if mode == Mode::Autopilot {
                    self.allow_all = true;
                }
            }
            ALLOW_ALL => match value {
                "on" | "true" => self.allow_all = true,
                "off" | "false" => self.allow_all = false,
                _ => return Err(format!("unknown allow_all value {value}")),
            },
            _ => return Err(format!("unknown setting {option}")),
        }
        Ok(())
    }

    pub fn active_context_tokens(&self, models: &[ModelEntry]) -> Option<u32> {
        models.iter().find(|m| m.id == self.model).and_then(|m| m.context_tokens(self.context_tier.as_deref()))
    }
}

/// Parses `models.list` + optional `models.listTokenPriceUnits` into catalog entries,
/// prepending `"auto"` when not already in the list.
pub(super) fn parse_catalog(list: &Value, price_units: Option<&Value>) -> Vec<ModelEntry> {
    let units = parse_price_units(price_units);
    let raw = list
        .get("models")
        .or_else(|| list.get("data"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut out = Vec::new();
    if !raw.iter().any(|m| str_of(m, "id") == Some("auto")) && !raw.is_empty() {
        out.push(ModelEntry {
            id: "auto".into(),
            name: "Auto".into(),
            description: Some("Let Copilot pick the best model".into()),
            is_default: false,
            default_effort: None,
            efforts: Vec::new(),
            context_tiers: Vec::new(),
            default_context_tokens: None,
            max_context_tokens: None,
            pricing: None,
        });
    }
    for m in raw {
        if let Some(entry) = parse_model(m, &units) {
            out.push(entry);
        }
    }
    out
}

fn parse_model(m: &Value, units: &HashMap<String, PriceUnit>) -> Option<ModelEntry> {
    let id = str_of(m, "id")?.to_owned();
    if m.get("model_picker_enabled").and_then(Value::as_bool) == Some(false)
        || m.get("modelPickerEnabled").and_then(Value::as_bool) == Some(false)
    {
        return None;
    }
    let name = str_of(m, "name")
        .or_else(|| str_of(m, "label"))
        .or_else(|| str_of(m, "displayName"))
        .filter(|s| !s.is_empty())
        .unwrap_or(&id)
        .to_owned();

    let mut efforts = parse_efforts(m);
    efforts.sort_by_key(|e| effort_rank(e));
    efforts.dedup();

    let limits = m.pointer("/capabilities/limits");
    let max_prompt =
        limits.and_then(|l| u32_of(l, "max_prompt_tokens").or_else(|| u32_of(l, "maxPromptTokens"))).filter(|&n| n > 0);
    let max_window = limits
        .and_then(|l| u32_of(l, "max_context_window_tokens").or_else(|| u32_of(l, "maxContextWindowTokens")))
        .filter(|&n| n > 0);

    let billing = m.get("billing");
    let multiplier = billing.and_then(|b| f64_of(b, "multiplier"));
    let raw_category = str_of(m, "modelPickerPriceCategory")
        .or_else(|| str_of(m, "model_picker_price_category"))
        .or_else(|| str_of(m, "priceCategory"))
        .or_else(|| str_of(m, "price_category"))
        .or_else(|| billing.and_then(|b| str_of(b, "priceCategory").or_else(|| str_of(b, "price_category"))));
    let mut cost_tier = raw_category.and_then(normalize_cost_tier).map(str::to_owned);

    let token_prices = billing.and_then(|b| b.get("token_prices").or_else(|| b.get("tokenPrices")));
    let unit = units.get(&id).copied().unwrap_or(PriceUnit::Credits);
    let (mut tiers, default_max, long_max) = parse_token_prices(token_prices, max_prompt, max_window, unit);

    let mut context_tiers = Vec::new();
    if let (Some(def_tokens), Some(long_tokens)) = (default_max, long_max)
        && def_tokens < long_tokens
    {
        context_tiers.push(ContextTierChoice {
            id: "default",
            label: format_tokens(def_tokens),
            tokens: def_tokens,
            description: "Default recommended context size",
        });
        context_tiers.push(ContextTierChoice {
            id: "long_context",
            label: format_tokens(long_tokens),
            tokens: long_tokens,
            description: "Maximum context window for longer sessions",
        });
    }

    if cost_tier.is_none()
        && let Some(def) = tiers.get("default")
    {
        cost_tier = Some(infer_cost_tier(def.output).to_owned());
    }
    if let Some(def_tokens) = default_max.or(max_window).or(max_prompt)
        && let Some(def) = tiers.get_mut("default")
        && def.context_tokens.is_none()
    {
        def.context_tokens = Some(def_tokens);
    }
    if let Some(long_tokens) = long_max
        && let Some(long) = tiers.get_mut("long_context")
    {
        long.context_tokens = Some(long_tokens);
    }

    let pricing = (!tiers.is_empty() || cost_tier.is_some() || multiplier.is_some()).then_some(AgentModelPricing {
        cost_tier,
        multiplier,
        tiers,
    });

    let description = multiplier
        .map(|mul| {
            let clean = round6(mul);
            if (clean - clean.round()).abs() < 1e-6 {
                format!("{}x", clean.round() as i64)
            } else {
                format!("{clean}x")
            }
        })
        .or_else(|| str_of(m, "description").filter(|d| !d.is_empty() && *d != name).map(str::to_owned))
        .or_else(|| (id == "auto").then(|| "Let Copilot pick the best model".to_owned()));

    let is_default = m
        .get("is_chat_default")
        .or_else(|| m.get("isChatDefault"))
        .or_else(|| m.get("isDefault"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let default_effort = str_of(m, "defaultReasoningEffort")
        .or_else(|| str_of(m, "default_reasoning_effort"))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    Some(ModelEntry {
        id,
        name,
        description,
        is_default,
        default_effort,
        efforts,
        context_tiers,
        default_context_tokens: default_max.or(max_window).or(max_prompt),
        max_context_tokens: long_max.or(default_max).or(max_window).or(max_prompt),
        pricing,
    })
}

fn parse_efforts(m: &Value) -> Vec<String> {
    let arr = m
        .get("supportedReasoningEfforts")
        .or_else(|| m.get("supported_reasoning_efforts"))
        .or_else(|| m.pointer("/capabilities/supports/reasoning_effort"))
        .or_else(|| m.pointer("/capabilities/supports/reasoningEffort"));
    arr.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned))
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PriceUnit {
    Credits,
    NanoAiu,
}

fn parse_price_units(raw: Option<&Value>) -> HashMap<String, PriceUnit> {
    let mut out = HashMap::new();
    let Some(raw) = raw else { return out };
    let unit_of = |s: &str| {
        if s.eq_ignore_ascii_case("nano_aiu") || s.eq_ignore_ascii_case("nanoaiu") || s.contains("nano") {
            Some(PriceUnit::NanoAiu)
        } else if s.to_ascii_lowercase().contains("credit") || s.eq_ignore_ascii_case("aic") {
            Some(PriceUnit::Credits)
        } else {
            None
        }
    };
    if let Some(map) =
        raw.get("units").or_else(|| raw.get("priceUnits")).or_else(|| raw.get("models")).and_then(Value::as_object)
    {
        for (k, v) in map {
            let u = v
                .as_str()
                .and_then(unit_of)
                .or_else(|| v.get("unit").or_else(|| v.get("priceUnit")).and_then(Value::as_str).and_then(unit_of));
            if let Some(u) = u {
                out.insert(k.clone(), u);
            }
        }
    }
    for key in ["units", "priceUnits", "models"] {
        if let Some(arr) = raw.get(key).and_then(Value::as_array) {
            for item in arr {
                let id = str_of(item, "modelId").or_else(|| str_of(item, "id"));
                let u = str_of(item, "unit").or_else(|| str_of(item, "priceUnit")).and_then(unit_of);
                if let (Some(id), Some(u)) = (id, u) {
                    out.insert(id.to_owned(), u);
                }
            }
        }
    }
    out
}

fn parse_token_prices(
    tp: Option<&Value>,
    max_prompt: Option<u32>,
    max_window: Option<u32>,
    unit: PriceUnit,
) -> (BTreeMap<String, AgentTokenPricing>, Option<u32>, Option<u32>) {
    let mut tiers = BTreeMap::new();
    let Some(tp) = tp else {
        return (tiers, None, max_window.or(max_prompt));
    };
    let batch =
        f64_of(tp, "batch_size").or_else(|| f64_of(tp, "batchSize")).filter(|&b| b > 0.0).unwrap_or(BATCH_TOKENS);
    let batch_scale = BATCH_TOKENS / batch;
    let unit_scale = match unit {
        PriceUnit::Credits => 1.0,
        PriceUnit::NanoAiu => 1.0 / NANO_AIU_PER_CREDIT,
    };
    let scale = batch_scale * unit_scale;

    let parse_tier = |node: &Value| -> Option<(AgentTokenPricing, Option<u32>)> {
        let input = f64_of(node, "input_price").or_else(|| f64_of(node, "inputPrice"))?;
        let output = f64_of(node, "output_price").or_else(|| f64_of(node, "outputPrice"))?;
        // Guard against raw nano-AIU numbers even if `listTokenPriceUnits` was unavailable.
        let effective = if unit == PriceUnit::Credits && (input >= 10_000_000.0 || output >= 10_000_000.0) {
            scale / NANO_AIU_PER_CREDIT
        } else {
            scale
        };
        let cache_read = f64_of(node, "cache_read_price")
            .or_else(|| f64_of(node, "cacheReadPrice"))
            .or_else(|| f64_of(node, "cache_price"))
            .or_else(|| f64_of(node, "cachePrice"))
            .map(|v| round6(v * effective));
        let cache_write = f64_of(node, "cache_write_price")
            .or_else(|| f64_of(node, "cacheWritePrice"))
            .map(|v| round6(v * effective));
        let ctx = u32_of(node, "max_prompt_tokens")
            .or_else(|| u32_of(node, "maxPromptTokens"))
            .or_else(|| u32_of(node, "context_max"))
            .or_else(|| u32_of(node, "contextMax"))
            .filter(|&n| n > 0);
        Some((
            AgentTokenPricing {
                input: round6(input * effective),
                output: round6(output * effective),
                cache_read,
                cache_write,
                context_tokens: ctx,
            },
            ctx,
        ))
    };

    // Both CAPI `/models` (`token_prices.default` + `token_prices.long_context`) and
    // `copilot --headless` `models.list` (top-level `tokenPrices` + `tokenPrices.longContext`)
    // share the same per-tier fields.
    let def_node = tp.get("default").unwrap_or(tp);
    let mut def_max = None;
    if let Some((def_pricing, ctx)) = parse_tier(def_node) {
        def_max = ctx;
        tiers.insert("default".into(), def_pricing);
    }

    let long_node = tp.get("longContext").or_else(|| tp.get("long_context"));
    let mut long_max = None;
    if let Some(long_node) = long_node
        && let Some((mut long_pricing, ctx)) = parse_tier(long_node)
    {
        // Use the full context window capacity (`1_000_000`) when available so models whose
        // `max_prompt_tokens` deduct `max_output_tokens` (e.g. `872_000` = `1M - 128K` on
        // GPT-6 Sol, `936_000` = `1M - 64K` on Gemini 4 Carbon) display cleanly as `1M`.
        let cap = match (ctx, max_window) {
            (Some(c), Some(w)) if w >= c => Some(w),
            (Some(c), _) => Some(c),
            (None, w) => w.or(max_prompt),
        };
        long_max = cap;
        long_pricing.context_tokens = cap;
        tiers.insert("long_context".into(), long_pricing);
    } else if let (Some(d), Some(p)) = (def_max, max_prompt)
        && d < p
        && let Some(def) = tiers.get("default").cloned()
    {
        let cap = max_window.filter(|&w| w >= p).unwrap_or(p);
        long_max = Some(cap);
        tiers.insert("long_context".into(), AgentTokenPricing { context_tokens: Some(cap), ..def });
    }

    (tiers, def_max, long_max)
}

fn normalize_cost_tier(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "lightweight" | "low" => Some("low"),
        "versatile" | "medium" | "standard" => Some("medium"),
        "powerful" | "high" | "premium" => Some("high"),
        "very_high" | "veryhigh" => Some("very_high"),
        _ => None,
    }
}

fn infer_cost_tier(output_credits_per_1m: f64) -> &'static str {
    if output_credits_per_1m < 300.0 {
        "low"
    } else if output_credits_per_1m <= 1500.0 {
        "medium"
    } else {
        "high"
    }
}

/// Formats token capacity matching VS Code (`200000` → `"200K"`, `1000000` → `"1M"`).
pub(super) fn format_tokens(tokens: u32) -> String {
    if tokens >= 1_000_000 {
        let m = (f64::from(tokens) / 1_000_000.0 * 10.0).floor() / 10.0;
        if (m - m.round()).abs() < 1e-6 { format!("{}M", m.round() as u32) } else { format!("{m:.1}M") }
    } else if tokens > 900_000 {
        "1M".into()
    } else if tokens >= 1_000 {
        format!("{}K", (f64::from(tokens) / 1_000.0).round() as u32)
    } else {
        tokens.to_string()
    }
}

pub(super) fn effort_rank(effort: &str) -> u8 {
    match effort {
        "none" => 0,
        "minimal" => 1,
        "low" => 2,
        "medium" => 3,
        "high" => 4,
        "xhigh" | "extra_high" => 5,
        "max" => 6,
        _ => 3,
    }
}

pub(super) fn effort_label(effort: &str) -> (&'static str, &'static str) {
    match effort {
        "none" => ("None", "No additional reasoning; fastest responses."),
        "minimal" => ("Minimal", "Least reasoning; fastest responses."),
        "low" => ("Low", "Minimal reasoning before responding."),
        "medium" => ("Medium", "Balanced reasoning and speed."),
        "high" => ("High", "More thorough reasoning; slower responses."),
        "xhigh" => ("Extra High", "Extensive reasoning for the hardest problems."),
        "max" => ("Max", "Maximum reasoning; slowest but most thorough."),
        _ => ("Default", ""),
    }
}

/// ACP `configOptions` for the active session settings.
pub(super) fn config_options(models: &[ModelEntry], s: &Settings) -> Value {
    let mut model_values: Vec<Value> = models.iter().map(model_option_value).collect();
    if !s.model.is_empty() && !models.iter().any(|m| m.id == s.model) {
        model_values.push(json!({ "value": s.model, "name": s.model }));
    }
    let mut out = Vec::new();
    if !model_values.is_empty() {
        out.push(json!({
            "id": MODEL,
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": s.model,
            "options": model_values,
        }));
    }
    if let Some(m) = models.iter().find(|m| m.id == s.model) {
        if let (Some(opt), Some(current)) = (effort_option_for(m, s.effort.as_deref()), s.effort.as_deref()) {
            let mut o = opt;
            o["currentValue"] = json!(current);
            out.push(o);
        }
        if let (Some(opt), Some(current)) =
            (context_tier_option_for(m, s.context_tier.as_deref()), s.context_tier.as_deref())
        {
            let mut o = opt;
            o["currentValue"] = json!(current);
            out.push(o);
        }
    }
    out.push(json!({
        "id": MODE,
        "name": "Mode",
        "category": "mode",
        "type": "select",
        "currentValue": s.mode.id(),
        "options": Mode::ALL.iter().map(|m| json!({
            "value": m.id(),
            "name": m.name(),
            "description": m.description(),
        })).collect::<Vec<_>>(),
    }));
    out.push(json!({
        "id": ALLOW_ALL,
        "name": "Allow All",
        "category": "permissions",
        "type": "select",
        "currentValue": if s.allow_all { "on" } else { "off" },
        "options": [
            { "value": "on", "name": "On", "description": "Automatically approve all tool, path, and URL requests" },
            { "value": "off", "name": "Off", "description": "Require approval for tool, path, and URL requests" },
        ],
    }));
    Value::Array(out)
}

/// Per-model options (`[reasoning_effort?, context_tier?]`) for every model in `models`,
/// each defaulted to Copilot's own defaults (respecting `user.settings.get` / CLI flags).
pub(super) fn per_model_options(models: &[ModelEntry], defaults: &UserDefaults) -> Vec<(String, Vec<Value>)> {
    models
        .iter()
        .map(|m| {
            let mut opts = Vec::new();
            if let Some(effort) = effort_option_for(m, m.default_effort(defaults.effort.as_deref())) {
                opts.push(effort);
            }
            if let Some(ctx) = context_tier_option_for(m, m.default_context_tier(defaults.context_tier.as_deref())) {
                opts.push(ctx);
            }
            (m.id.clone(), opts)
        })
        .collect()
}

fn model_option_value(m: &ModelEntry) -> Value {
    let mut v = json!({ "value": m.id, "name": m.name });
    if let Some(d) = &m.description {
        v["description"] = json!(d);
    }
    if let Some(pricing) = &m.pricing {
        let mut meta = serde_json::Map::new();
        meta.insert("pricing".into(), json!(pricing));
        if let Some(cat) = &pricing.cost_tier {
            meta.insert("copilotPriceCategory".into(), json!(cat));
        }
        v["_meta"] = Value::Object(meta);
    }
    v
}

fn effort_option_for(m: &ModelEntry, current: Option<&str>) -> Option<Value> {
    if m.efforts.len() <= 1 && m.efforts.is_empty() {
        return None;
    }
    let default = current.filter(|c| m.efforts.iter().any(|e| e == *c)).or_else(|| m.default_effort(None))?;
    let options: Vec<Value> = m
        .efforts
        .iter()
        .map(|e| {
            let (label, desc) = effort_label(e);
            let name = if label == "Default" { capitalize(e) } else { label.to_owned() };
            let mut item = json!({ "value": e, "name": name });
            if !desc.is_empty() {
                item["description"] = json!(desc);
            }
            item
        })
        .collect();
    Some(json!({
        "id": EFFORT,
        "name": "Effort Level",
        "description": "How much reasoning the model performs before responding. Higher effort can improve quality at the cost of speed.",
        "category": "thought_level",
        "type": "select",
        "currentValue": default,
        "options": options,
    }))
}

fn context_tier_option_for(m: &ModelEntry, current: Option<&str>) -> Option<Value> {
    if m.context_tiers.len() < 2 {
        return None;
    }
    let default =
        current.filter(|c| m.context_tiers.iter().any(|t| t.id == *c)).or_else(|| m.default_context_tier(None))?;
    let options: Vec<Value> = m
        .context_tiers
        .iter()
        .map(|t| {
            json!({
                "value": t.id,
                "name": t.label,
                "description": t.description,
            })
        })
        .collect();
    Some(json!({
        "id": CONTEXT_TIER,
        "name": "Context Size",
        "description": "Context window size for this model.",
        "category": "model_config",
        "type": "select",
        "currentValue": default,
        "options": options,
    }))
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn round6(n: f64) -> f64 {
    let r = (n * 1_000_000.0).round() / 1_000_000.0;
    if r == 0.0 { 0.0 } else { r }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn f64_of(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn u32_of(v: &Value, key: &str) -> Option<u32> {
    v.get(key).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok())
}
