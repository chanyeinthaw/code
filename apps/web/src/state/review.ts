import { createReviewEnvironmentAtoms } from "@satslab/client-runtime/state/review";

import { connectionAtomRuntime } from "../connection/runtime";

export const reviewEnvironment = createReviewEnvironmentAtoms(connectionAtomRuntime);
