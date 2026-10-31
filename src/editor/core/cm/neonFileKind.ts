/** What a `.neon` file is for, from its name alone, like intellij-neon's `NeonFileKind`. */
export type NeonFileKind = "config" | "phpstan" | "translation" | "icuTranslation";

export function isNeonTranslation(kind: NeonFileKind): boolean {
  return kind === "translation" || kind === "icuTranslation";
}

// <domain>.<locale>.neon. The locale is a BCP 47 or POSIX tag: sk, sk_SK, pt-BR, zh-Hant, es-419.
const TRANSLATION_NAME = /^(.+)\.([a-z]{2,3})(?:[-_][a-z]{4})?(?:[-_](?:[a-z]{2}|[0-9]{3}))?\.neon$/i;

// The list of known languages is what keeps `config.dev.neon` a config: `dev` has the shape of a locale.
// ISO 639-1 plus the languages of JDK 24's locales, the set the plugin reads from the JDK.
const LANGUAGES = new Set(
  `aa ab ae af agq ak am an ann ar as asa ast av ay az ba bal bas be bem bez bg bgc bh bho bi blo bm bn bo br brx bs
ca ccp ce ceb cgg ch chr ckb co cr cs csw cu cv cy da dav de dje doi dsb dua dv dyo dz ebu ee el en eo es et eu ewo
fa ff fi fil fj fo fr frr fur fy ga gaa gd gl gn gsw gu guz gv ha haw he hi ho hr hsb ht hu hy hz ia id ie ig ii ik
in io is it iu iw ja jgo ji jmc jv ka kab kam kde kea kg kgp khq ki kj kk kkj kl kln km kn ko kok kr ks ksb ksf ksh
ku kv kw kxv ky la lag lb lg li lij lkt lmo ln lo lrc lt lu luo luy lv mai mas mdf mer mfe mg mgh mgo mh mi mk ml mn
mni mo mr ms mt mua my mzn na naq nb nd nds ne ng nl nmg nn nnh no nqo nr nso nus nv ny nyn oc oj om or os pa pcm pi
pis pl prg ps pt qu raj rm rn ro rof ru rw rwk sa sah saq sat sbp sc sd se seh ses sg shi si sk sl sm smn sms sn so
sq sr ss st su sv sw syr szl ta te teo tg th ti tk tl tn to tok tr ts tt tw twq ty tzm ug uk ur uz vai ve vec vi vmw
vo vun wa wae wo xh xnr xog yav yi yo yrl yue za zgh zh zu`.split(/\s+/),
);

/** A value that reads as a file: the plugin's `.php` and `.neon`, and the `.stub` of PHPStan's `stubFiles`. */
export function isNeonFilePath(text: string): boolean {
  return /.+\.(?:php|neon|stub)$/.test(text);
}

export function neonFileKind(fileName: string): NeonFileKind {
  if (/phpstan/i.test(fileName) && fileName.endsWith(".neon")) return "phpstan";
  const match = TRANSLATION_NAME.exec(fileName);
  if (!match || !LANGUAGES.has(match[2]!.toLowerCase())) return "config";
  return match[1]!.endsWith("+intl-icu") ? "icuTranslation" : "translation";
}
