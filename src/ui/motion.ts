/**
 * Motion counterparts of the `--ease` / `--dur-fast` / `--dur` tokens
 * (styles/tokens.css), for enter/exit animations CSS cannot express.
 */
import type { Transition } from "motion/react";

export const EASE = [0.2, 0, 0, 1] as const;

export const FAST: Transition = { duration: 0.08, ease: EASE };
export const NORMAL: Transition = { duration: 0.14, ease: EASE };
