import { plumbBoundaryRules } from "./rules/boundaries.ts";
import { plumbCallRules } from "./rules/calls.ts";
import { plumbCommentRules } from "./rules/comments.ts";
import { plumbLayoutRules } from "./rules/layout.ts";
import { plumbNameRules } from "./rules/names.ts";
import { testAssertionsRule } from "./rules/tests.ts";
import { plumbValueRules } from "./rules/values.ts";

export const plumbTypescriptRules = {
  ...plumbBoundaryRules,
  ...plumbCallRules,
  ...plumbCommentRules,
  ...plumbLayoutRules,
  ...plumbNameRules,
  "test-assertions": testAssertionsRule,
  ...plumbValueRules,
};
