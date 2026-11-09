import { plumbClassRules } from "./react/classes.ts";
import { plumbComponentRules } from "./react/components.ts";

export const plumbReactRules = { ...plumbClassRules, ...plumbComponentRules };
