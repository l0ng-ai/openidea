use super::models::{self, CONTEXT_TIER, EFFORT, MODEL, Mode, Settings, UserDefaults};
use super::{acp_args, acp_fallback_spec, attach, headless_args};
use crate::config;
use crate::provider::Driver;
use ide_jsonrpc::{Framing, Handler, Peer, codes};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

fn sample_models_list() -> Value {
    json!({
        "models": [
            {
                "id": "gemini-4-carbon",
                "name": "Gemini 4 Carbon",
                "priceCategory": "versatile",
                "supportedReasoningEfforts": ["low", "medium", "high"],
                "defaultReasoningEffort": "medium",
                "capabilities": {
                    "supports": { "vision": true, "reasoningEffort": true },
                    "limits": {
                        "max_context_window_tokens": 1_000_000,
                        "max_prompt_tokens": 1_000_000,
                        "max_output_tokens": 64_000
                    }
                },
                "billing": {
                    "is_premium": true,
                    "multiplier": 1.0,
                    "token_prices": {
                        "batch_size": 1_000_000,
                        "preferred_tier": "default",
                        "default": {
                            "input_price": 100.0,
                            "output_price": 500.0,
                            "cache_read_price": 10.0,
                            "cache_write_price": 0.0,
                            "max_prompt_tokens": 200_000
                        },
                        "long_context": {
                            "input_price": 200.0,
                            "output_price": 1000.0,
                            "cache_read_price": 10.0,
                            "cache_write_price": 0.0,
                            "max_prompt_tokens": 1_000_000
                        }
                    }
                }
            },
            {
                "id": "gpt-5.6-sol",
                "name": "GPT-5.6 Sol",
                "priceCategory": "powerful",
                "supportedReasoningEfforts": ["none", "low", "medium", "high", "xhigh", "max"],
                "defaultReasoningEffort": "medium",
                "capabilities": {
                    "supports": { "vision": true },
                    "limits": {
                        "max_context_window_tokens": 1_000_000,
                        "max_prompt_tokens": 1_000_000
                    }
                },
                "billing": {
                    "multiplier": 2.0,
                    "token_prices": {
                        "batch_size": 1_000_000,
                        "default": {
                            "input_price": 250_000_000_000.0,
                            "output_price": 1_500_000_000_000.0,
                            "cache_read_price": 25_000_000_000.0,
                            "cache_write_price": 0.0,
                            "max_prompt_tokens": 200_000
                        },
                        "long_context": {
                            "input_price": 500_000_000_000.0,
                            "output_price": 3_000_000_000_000.0,
                            "cache_read_price": 50_000_000_000.0,
                            "cache_write_price": 0.0,
                            "max_prompt_tokens": 1_000_000
                        }
                    }
                }
            },
            {
                "id": "mai-experimental-internal",
                "name": "MAI Experimental",
                "priceCategory": "lightweight",
                "supportedReasoningEfforts": ["low", "medium"],
                "capabilities": {
                    "limits": {
                        "max_context_window_tokens": 131_072,
                        "max_prompt_tokens": 131_072
                    }
                },
                "billing": {
                    "multiplier": 0.33
                }
            }
        ]
    })
}

fn sample_price_units() -> Value {
    json!({
        "units": {
            "gemini-4-carbon": "ai_credits",
            "gpt-5.6-sol": "nano_aiu"
        }
    })
}

#[test]
fn parses_an_enabled_auto_only_catalog() {
    let list = json!({
        "models": [],
        "auto": {
            "defaultTier": "balance",
            "tiers": [
                {
                    "id": "balance",
                    "displayName": "Standard",
                    "type": "auto",
                    "fusionTier": "standard",
                    "status": { "enabled": true, "pickerVisible": true }
                },
                {
                    "id": "hydrafusion",
                    "displayName": "High",
                    "type": "fusion",
                    "fusionTier": "high",
                    "status": {
                        "enabled": false,
                        "pickerVisible": true,
                        "reason": "user_not_eligible"
                    }
                },
                {
                    "id": "fast",
                    "displayName": "Fast",
                    "type": "auto",
                    "status": { "enabled": true, "pickerVisible": false }
                }
            ],
            "providerId": "copilot"
        },
        "imageModels": []
    });

    let catalog = models::parse_catalog(&list, None);
    assert_eq!(catalog.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["auto"]);
    assert_eq!(Settings::new(&catalog, &UserDefaults::default()).model, "auto");

    let options =
        config::parse_options(&models::config_options(&catalog, &Settings::new(&catalog, &UserDefaults::default())));
    let model = options.iter().find(|option| option.id == MODEL).unwrap();
    assert_eq!(model.current.as_deref(), Some("auto"));
    assert_eq!(model.values.iter().map(|value| value.value.as_str()).collect::<Vec<_>>(), ["auto"]);
}

#[test]
fn rejects_an_auto_only_catalog_when_every_tier_is_disabled() {
    let list = json!({
        "models": [],
        "auto": {
            "defaultTier": "balance",
            "tiers": [
                {
                    "id": "balance",
                    "status": { "enabled": false, "pickerVisible": true }
                }
            ]
        }
    });

    assert!(models::parse_catalog(&list, None).is_empty());
}

#[test]
fn parses_tiered_context_windows_pricing_and_uses_copilots_own_defaults() {
    let catalog = models::parse_catalog(&sample_models_list(), Some(&sample_price_units()));
    assert_eq!(
        catalog.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["auto", "gemini-4-carbon", "gpt-5.6-sol", "mai-experimental-internal"]
    );

    let gemini = catalog.iter().find(|m| m.id == "gemini-4-carbon").unwrap();
    assert_eq!(gemini.default_effort(None), Some("medium"));
    assert_eq!(gemini.default_context_tier(None), Some("default"));
    assert_eq!(
        gemini.context_tiers.iter().map(|t| (t.id, t.label.as_str(), t.tokens)).collect::<Vec<_>>(),
        [("default", "200K", 200_000), ("long_context", "1M", 1_000_000)]
    );
    let pricing = gemini.pricing.as_ref().unwrap();
    assert_eq!(pricing.cost_tier.as_deref(), Some("medium"));
    let long_p = &pricing.tiers["long_context"];
    assert_eq!(
        (long_p.input, long_p.output, long_p.cache_read, long_p.cache_write),
        (200.0, 1000.0, Some(10.0), Some(0.0))
    );
    let def_p = &pricing.tiers["default"];
    assert_eq!((def_p.input, def_p.output), (100.0, 500.0));

    // Nano-AIU conversion (10^9 nano-AIU = 1 AI Credit).
    let sol = catalog.iter().find(|m| m.id == "gpt-5.6-sol").unwrap();
    assert_eq!(sol.default_effort(None), Some("medium"));
    assert_eq!(sol.default_context_tier(None), Some("default"));
    let sol_long = &sol.pricing.as_ref().unwrap().tiers["long_context"];
    assert_eq!((sol_long.input, sol_long.output, sol_long.cache_read), (500.0, 3000.0, Some(50.0)));

    // Single-window model has no multi-tier `context_tier` toggle.
    let mai = catalog.iter().find(|m| m.id == "mai-experimental-internal").unwrap();
    assert!(mai.context_tiers.is_empty());
    assert_eq!(mai.default_effort(None), Some("medium"));

    // Initial settings pick Copilot's own defaults (`medium` effort + `default` 200K context).
    let mut s = Settings::new(&catalog, &UserDefaults::default());
    assert_eq!(s.model, "gemini-4-carbon");
    assert_eq!(s.effort.as_deref(), Some("medium"));
    assert_eq!(s.context_tier.as_deref(), Some("default"));
    assert_eq!(s.active_context_tokens(&catalog), Some(200_000));

    // Switching to GPT-5.6 Sol without an explicit override stays on Copilot's defaults (`medium` + `default`).
    s.set(&catalog, MODEL, "gpt-5.6-sol").unwrap();
    assert_eq!(s.effort.as_deref(), Some("medium"));
    assert_eq!(s.context_tier.as_deref(), Some("default"));

    // Explicit session overrides (`xhigh` + `long_context`) stick across models that support them,
    // and fall back to Copilot's default when switching to a model that does not.
    s.set(&catalog, EFFORT, "xhigh").unwrap();
    s.set(&catalog, CONTEXT_TIER, "long_context").unwrap();
    assert_eq!(s.active_context_tokens(&catalog), Some(1_000_000));
    s.set(&catalog, MODEL, "mai-experimental-internal").unwrap();
    assert_eq!(s.effort.as_deref(), Some("medium"));
    assert_eq!(s.context_tier, None);

    // User settings from `user.settings.get` (1.0.112+ `{ value, default, isDefault }` shape) and CLI flags are honored.
    let rpc_settings = json!({
        "settings": {
            "model": { "value": "gpt-5.6-sol", "default": null, "isDefault": false },
            "effortLevel": { "value": "high", "default": null, "isDefault": false },
            "contextTier": { "value": "long_context", "default": null, "isDefault": false },
            "defaultMode": { "value": "plan", "default": "interactive", "isDefault": false },
        }
    });
    let user_defs = UserDefaults::from_rpc_and_args(Some(&rpc_settings), &[]);
    let configured = Settings::new(&catalog, &user_defs);
    assert_eq!(configured.model, "gpt-5.6-sol");
    assert_eq!(configured.effort.as_deref(), Some("high"));
    assert_eq!(configured.context_tier.as_deref(), Some("long_context"));
    assert_eq!(configured.mode, Mode::Plan);

    // Per-model discovery options preserve pricing on `model` values and emit Copilot's defaults.
    let raw = models::config_options(&catalog, &Settings::new(&catalog, &UserDefaults::default()));
    let parsed = config::parse_options(&raw);
    let model_opt = parsed.iter().find(|o| o.id == MODEL).unwrap();
    let gem_val = model_opt.values.iter().find(|v| v.value == "gemini-4-carbon").unwrap();
    assert_eq!(gem_val.pricing.as_ref().unwrap().cost_tier.as_deref(), Some("medium"));
    assert_eq!(parsed.iter().find(|o| o.id == EFFORT).unwrap().current.as_deref(), Some("medium"));
    assert_eq!(parsed.iter().find(|o| o.id == CONTEXT_TIER).unwrap().current.as_deref(), Some("default"));
}

#[test]
fn parses_headless_sdk_models_list_flat_token_prices_and_single_tier_models() {
    let sdk_list = json!({
        "models": [
            { "id": "auto", "name": "Auto" },
            {
                "id": "gemini-4-carbon",
                "name": "Gemini 4 Carbon",
                "modelPickerCategory": "powerful",
                "modelPickerPriceCategory": "medium",
                "supportedReasoningEfforts": ["low", "medium", "high"],
                "capabilities": {
                    "limits": {
                        "max_context_window_tokens": 1_000_000,
                        "max_output_tokens": 64_000,
                        "max_prompt_tokens": 936_000
                    }
                },
                "billing": {
                    "tokenPrices": {
                        "inputPrice": 200,
                        "outputPrice": 1000,
                        "cachePrice": 10,
                        "cacheReadPrice": 10,
                        "cacheWritePrice": 0,
                        "contextMax": 200_000,
                        "maxPromptTokens": 200_000,
                        "batchSize": 1_000_000,
                        "longContext": {
                            "inputPrice": 200,
                            "outputPrice": 1000,
                            "cachePrice": 10,
                            "cacheReadPrice": 10,
                            "cacheWritePrice": 0,
                            "contextMax": 936_000,
                            "maxPromptTokens": 936_000
                        }
                    }
                }
            },
            {
                "id": "gpt-6-sol",
                "name": "GPT-6 Sol",
                "modelPickerPriceCategory": "medium",
                "supportedReasoningEfforts": ["none", "low", "medium", "high", "xhigh", "max"],
                "capabilities": {
                    "limits": {
                        "max_context_window_tokens": 1_000_000,
                        "max_output_tokens": 128_000,
                        "max_prompt_tokens": 872_000
                    }
                },
                "billing": {
                    "tokenPrices": {
                        "inputPrice": 250,
                        "outputPrice": 1250,
                        "contextMax": 272_000,
                        "maxPromptTokens": 272_000,
                        "batchSize": 1_000_000,
                        "longContext": {
                            "inputPrice": 500,
                            "outputPrice": 2500,
                            "contextMax": 872_000,
                            "maxPromptTokens": 872_000
                        }
                    }
                }
            },
            {
                "id": "gpt-5.3-codex",
                "name": "GPT-5.3-Codex",
                "modelPickerPriceCategory": "medium",
                "supportedReasoningEfforts": ["low", "medium", "high", "xhigh"],
                "capabilities": {
                    "limits": {
                        "max_context_window_tokens": 400_000,
                        "max_output_tokens": 128_000,
                        "max_prompt_tokens": 272_000
                    }
                },
                "billing": {
                    "tokenPrices": {
                        "inputPrice": 150,
                        "outputPrice": 600,
                        "contextMax": 272_000,
                        "maxPromptTokens": 272_000,
                        "batchSize": 1_000_000
                    }
                }
            }
        ]
    });
    let units = json!({
        "units": [
            { "modelId": "gemini-4-carbon", "unit": "ai_credits" },
            { "modelId": "gpt-6-sol", "unit": "ai_credits" },
            { "modelId": "gpt-5.3-codex", "unit": "ai_credits" }
        ]
    });

    let catalog = models::parse_catalog(&sdk_list, Some(&units));
    let carbon = catalog.iter().find(|m| m.id == "gemini-4-carbon").unwrap();
    assert_eq!(
        carbon.context_tiers.iter().map(|t| (t.id, t.label.as_str())).collect::<Vec<_>>(),
        [("default", "200K"), ("long_context", "1M")]
    );
    let cp = carbon.pricing.as_ref().unwrap();
    assert_eq!(cp.cost_tier.as_deref(), Some("medium"));
    assert_eq!((cp.tiers["long_context"].input, cp.tiers["long_context"].output), (200.0, 1000.0));

    let sol = catalog.iter().find(|m| m.id == "gpt-6-sol").unwrap();
    assert_eq!(
        sol.context_tiers.iter().map(|t| (t.id, t.label.as_str())).collect::<Vec<_>>(),
        [("default", "272K"), ("long_context", "1M")]
    );

    let codex = catalog.iter().find(|m| m.id == "gpt-5.3-codex").unwrap();
    assert!(codex.context_tiers.is_empty(), "single-tier model must not get a synthetic long_context tier");
}

#[test]
fn headless_and_acp_args_roundtrip_while_preserving_user_flags() {
    assert_eq!(headless_args(&["--acp".into()]), vec!["--headless", "--no-auto-update", "--stdio"]);
    assert_eq!(
        headless_args(&["--log-level".into(), "debug".into(), "--headless".into(), "--stdio".into()]),
        vec!["--log-level", "debug", "--headless", "--stdio", "--no-auto-update"]
    );
    assert_eq!(
        acp_args(&[
            "--headless".into(),
            "--no-auto-update".into(),
            "--stdio".into(),
            "--context".into(),
            "long_context".into()
        ]),
        vec!["--acp", "--context", "long_context"]
    );
    let spec = crate::provider::builtin_spec("copilot").unwrap();
    assert_eq!(spec.driver, Driver::Copilot);
    let fallback = acp_fallback_spec(&spec);
    assert_eq!(fallback.driver, Driver::Acp);
    assert_eq!(fallback.args, vec!["--acp"]);
}

struct FakeCopilotServer {
    peer: OnceLock<Peer>,
    calls: Mutex<Vec<(String, Value)>>,
    /// `session.send` leaves a shell running: the main loop goes idle but the session doesn't.
    background_shell: bool,
}

fn copilot_event(sid: &str, event: Value) -> Value {
    json!({ "sessionId": sid, "event": event })
}

impl Handler for FakeCopilotServer {
    fn on_notification(&self, _method: &str, _params: Value) {}

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        self.calls.lock().push((method.to_owned(), params.clone()));
        match method {
            "connect" => Ok(json!({ "ok": true, "protocolVersion": 3, "version": "1.0.112" })),
            "models.list" => Ok(sample_models_list()),
            "models.listTokenPriceUnits" => Ok(sample_price_units()),
            "user.settings.get" => Ok(json!({ "settings": { "model": "gemini-4-carbon" } })),
            "commands.list" => Ok(json!({ "commands": [{ "name": "compact", "description": "Compact context" }] })),
            "skills.discover" => Ok(json!({ "skills": [] })),
            "session.create" => Ok(json!({ "sessionId": "cop-sess-1" })),
            "session.resume" => Ok(json!({ "sessionId": params["sessionId"] })),
            "session.model.getCurrent" => Ok(json!({ "modelId": "gemini-4-carbon" })),
            "session.model.switchTo" => Ok(json!({ "modelId": params["modelId"] })),
            "session.mode.set" => Ok(json!({})),
            "session.permissions.setApproveAll" => {
                assert!(params.get("enabled").and_then(Value::as_bool).is_some());
                Ok(json!({ "success": true }))
            }
            "session.tasks.list" => Ok(json!({ "tasks": [
                { "id": "shell-1", "type": "shell", "status": "running", "description": "",
                  "command": "gh pr checks 3819 --watch", "attachmentMode": "attached" },
                { "id": "shell-0", "type": "shell", "status": "completed", "description": "ls", "command": "ls" },
            ] })),
            "session.tasks.cancel" => Ok(json!({ "cancelled": true })),
            "session.abort" => Ok(json!({})),
            "session.send" if self.background_shell => {
                if let Some(peer) = self.peer.get().cloned() {
                    let sid = params["sessionId"].as_str().unwrap_or("cop-sess-1").to_owned();
                    std::thread::spawn(move || {
                        for event in [
                            json!({ "id": "b1", "type": "assistant.turn_start", "data": { "turnId": "t1" } }),
                            json!({ "id": "b2", "type": "assistant.idle", "data": {} }),
                            json!({ "id": "b3", "type": "session.background_tasks_changed", "data": {} }),
                        ] {
                            let _ = peer.notify("session.event", copilot_event(&sid, event));
                        }
                    });
                }
                Ok(json!({ "messageId": "msg-1" }))
            }
            "session.send" => {
                if let Some(peer) = self.peer.get().cloned() {
                    let sid = params["sessionId"].as_str().unwrap_or("cop-sess-1").to_owned();
                    std::thread::spawn(move || {
                        let _ = peer.notify(
                            "session.event",
                            json!({
                                "sessionId": sid,
                                "event": {
                                    "id": "e1",
                                    "type": "session.usage_info",
                                    "data": { "currentTokens": 42_000, "tokenLimit": 1_000_000 }
                                }
                            }),
                        );
                        let _ = peer.notify(
                            "session.event",
                            json!({
                                "sessionId": sid,
                                "event": {
                                    "id": "e2",
                                    "type": "assistant.message_delta",
                                    "data": { "messageId": "m1", "deltaContent": "Hello from 1M context!" }
                                }
                            }),
                        );
                        let _ = peer.notify(
                            "session.event",
                            json!({
                                "sessionId": sid,
                                "event": {
                                    "id": "e3",
                                    "type": "session.idle",
                                    "data": { "aborted": false, "mode": "interactive" }
                                }
                            }),
                        );
                    });
                }
                Ok(json!({ "messageId": "msg-1" }))
            }
            _ => Err((codes::METHOD_NOT_FOUND, format!("unexpected {method}"))),
        }
    }
}

struct CollectUpdates(Mutex<Vec<Value>>);

impl Handler for CollectUpdates {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/update" {
            self.0.lock().push(params["update"].clone());
        }
    }

    fn on_request(&self, method: &str, _params: Value) -> Result<Value, (i64, String)> {
        Err((codes::METHOD_NOT_FOUND, format!("unexpected {method}")))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shim_creates_session_with_copilot_defaults_switches_tiers_and_streams_turns() {
    let server =
        Arc::new(FakeCopilotServer { peer: OnceLock::new(), calls: Mutex::new(Vec::new()), background_shell: false });
    let updates = Arc::new(CollectUpdates(Mutex::new(Vec::new())));
    let server_clone = server.clone();
    let client = attach(updates.clone(), move |events| {
        let (a, b) = tokio::io::duplex(1 << 16);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        let srv_peer = Peer::connect_framed(br, bw, server_clone.clone(), Framing::ContentLength);
        let _ = server_clone.peer.set(srv_peer);
        Ok(Peer::connect_framed(ar, aw, events, Framing::ContentLength))
    })
    .unwrap();

    let init: Value = client.request("initialize", json!({}), None).await.unwrap();
    assert_eq!(init["agentInfo"]["version"], "1.0.112");
    assert_eq!(init["agentCapabilities"]["_meta"]["openidea"]["steer"], true);

    let created: Value = client.request("session/new", json!({ "cwd": "/tmp", "mcpServers": [] }), None).await.unwrap();
    assert_eq!(created["sessionId"], "cop-sess-1");

    // Verify `session.create` sent `"trustWorkingDirectory": "session"`, `gemini-4-carbon`,
    // and Copilot's own defaults (`reasoningEffort: "medium"` and `contextTier: "default"`).
    {
        let calls = server.calls.lock();
        let (_, create_params) = calls.iter().find(|(m, _)| m == "session.create").unwrap();
        assert_eq!(create_params["trustWorkingDirectory"], "session");
        assert_eq!(create_params["model"], "gemini-4-carbon");
        assert_eq!(create_params["reasoningEffort"], "medium");
        assert_eq!(create_params["contextTier"], "default");
    }

    // Switch Context Size up to 1M (`long_context`) and Effort to `high` live via `session/set_config_option`.
    let _: Value = client
        .request(
            "session/set_config_option",
            json!({
                "sessionId": "cop-sess-1",
                "configId": "reasoning_effort",
                "value": "high"
            }),
            None,
        )
        .await
        .unwrap();
    let switched_1m: Value = client
        .request(
            "session/set_config_option",
            json!({
                "sessionId": "cop-sess-1",
                "configId": "context_tier",
                "value": "long_context"
            }),
            None,
        )
        .await
        .unwrap();
    let opts_1m = config::options_of(&switched_1m);
    assert_eq!(opts_1m.iter().find(|o| o.id == "context_tier").unwrap().current.as_deref(), Some("long_context"));

    // Run a turn and verify 1M usage_update + streamed message chunk.
    let prompt_res: Value = client
        .request(
            "session/prompt",
            json!({
                "sessionId": "cop-sess-1",
                "prompt": [{ "type": "text", "text": "Explain architecture" }]
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(prompt_res["stopReason"], "end_turn");
    {
        let seen = updates.0.lock();
        assert!(
            seen.iter().any(|u| u["sessionUpdate"] == "usage_update" && u["size"] == 1_000_000 && u["used"] == 42_000)
        );
        assert!(
            seen.iter().any(
                |u| u["sessionUpdate"] == "agent_message_chunk" && u["content"]["text"] == "Hello from 1M context!"
            )
        );
    }

    // Switch Context Size back down to 200K (`default`) live via `session/set_config_option`.
    let switched: Value = client
        .request(
            "session/set_config_option",
            json!({
                "sessionId": "cop-sess-1",
                "configId": "context_tier",
                "value": "default"
            }),
            None,
        )
        .await
        .unwrap();
    let opts = config::options_of(&switched);
    assert_eq!(opts.iter().find(|o| o.id == "context_tier").unwrap().current.as_deref(), Some("default"));
    {
        let calls = server.calls.lock();
        let (_, sw_params) = calls.iter().rfind(|(m, _)| m == "session.model.switchTo").unwrap();
        assert_eq!(sw_params["modelId"], "gemini-4-carbon");
        assert_eq!(sw_params["reasoningEffort"], "high");
        assert_eq!(sw_params["contextTier"], "default");
    }
    // Switching context_tier immediately emits an updated `usage_update` with `size: 200_000`.
    assert!(
        updates
            .0
            .lock()
            .iter()
            .any(|u| u["sessionUpdate"] == "usage_update" && u["size"] == 200_000 && u["used"] == 42_000)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shim_forwards_disabled_mcp_servers_on_create_and_resume() {
    let server =
        Arc::new(FakeCopilotServer { peer: OnceLock::new(), calls: Mutex::new(Vec::new()), background_shell: false });
    let updates = Arc::new(CollectUpdates(Mutex::new(Vec::new())));
    let server_clone = server.clone();
    let client = attach(updates, move |events| {
        let (a, b) = tokio::io::duplex(1 << 16);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        let srv_peer = Peer::connect_framed(br, bw, server_clone.clone(), Framing::ContentLength);
        let _ = server_clone.peer.set(srv_peer);
        Ok(Peer::connect_framed(ar, aw, events, Framing::ContentLength))
    })
    .unwrap();

    let _: Value = client.request("initialize", json!({}), None).await.unwrap();
    let disabled = json!(["datadog", "github-mcp-server", "linear", "playwright", "slack-official"]);
    let _: Value = client
        .request(
            "session/new",
            json!({
                "cwd": "/tmp",
                "mcpServers": [],
                "_meta": { "openidea": { "mcpServersOff": disabled } }
            }),
            None,
        )
        .await
        .unwrap();
    let _: Value = client
        .request(
            "session/load",
            json!({
                "sessionId": "cop-sess-1",
                "cwd": "/tmp",
                "mcpServers": [],
                "_meta": { "openidea": { "mcpServersOff": disabled } }
            }),
            None,
        )
        .await
        .unwrap();

    let calls = server.calls.lock();
    let (_, create_params) = calls.iter().find(|(m, _)| m == "session.create").unwrap();
    assert_eq!(create_params["disabledMcpServers"], disabled);
    let (_, resume_params) = calls.iter().find(|(m, _)| m == "session.resume").unwrap();
    assert_eq!(resume_params["disabledMcpServers"], disabled);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_ends_a_turn_left_running_only_by_background_shells() {
    let server =
        Arc::new(FakeCopilotServer { peer: OnceLock::new(), calls: Mutex::new(Vec::new()), background_shell: true });
    let updates = Arc::new(CollectUpdates(Mutex::new(Vec::new())));
    let server_clone = server.clone();
    let client = attach(updates.clone(), move |events| {
        let (a, b) = tokio::io::duplex(1 << 16);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        let srv_peer = Peer::connect_framed(br, bw, server_clone.clone(), Framing::ContentLength);
        let _ = server_clone.peer.set(srv_peer);
        Ok(Peer::connect_framed(ar, aw, events, Framing::ContentLength))
    })
    .unwrap();
    let init: Value = client.request("initialize", json!({}), None).await.unwrap();
    assert_eq!(init["agentCapabilities"]["_meta"]["openidea"]["backgroundTasks"], true);
    let _: Value = client.request("session/new", json!({ "cwd": "/tmp", "mcpServers": [] }), None).await.unwrap();

    let prompt_client = client.clone();
    let turn = tokio::spawn(async move {
        prompt_client
            .request::<_, Value>(
                "session/prompt",
                json!({ "sessionId": "cop-sess-1", "prompt": [{ "type": "text", "text": "watch CI" }] }),
                None,
            )
            .await
    });

    // The running shell shows as a background task.
    let mut shown = None;
    for _ in 0..500 {
        shown = updates.0.lock().iter().find(|u| u["sessionUpdate"] == crate::BACKGROUND_TASKS_UPDATE).cloned();
        if shown.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        shown.unwrap()["tasks"],
        json!([{ "task_id": "shell-1", "task_type": "local_bash", "description": "gh pr checks 3819 --watch" }])
    );

    let _: Value = client
        .request("_openidea/stop_task", json!({ "sessionId": "cop-sess-1", "taskId": "shell-1" }), None)
        .await
        .unwrap();
    assert!(
        server
            .calls
            .lock()
            .iter()
            .any(|(m, p)| m == "session.tasks.cancel" && p["sessionId"] == "cop-sess-1" && p["id"] == "shell-1")
    );

    // The main loop is idle, so Stop ends the turn even though `session.idle` never comes.
    assert!(!turn.is_finished());
    client.notify("session/cancel", json!({ "sessionId": "cop-sess-1" })).unwrap();
    let res = tokio::time::timeout(Duration::from_secs(5), turn).await.unwrap().unwrap().unwrap();
    assert_eq!(res["stopReason"], "cancelled");
    assert!(!server.calls.lock().iter().any(|(m, _)| m == "session.abort"));
}
