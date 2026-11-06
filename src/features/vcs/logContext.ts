import { createContext } from "react";
import type { LogOptions } from "./logOptions";

export const LogIdContext = createContext<string | null>(null);
export const LogOptionsContext = createContext<LogOptions | null>(null);
