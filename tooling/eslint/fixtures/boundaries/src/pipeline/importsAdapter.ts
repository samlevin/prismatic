// Deliberate violation: the pipeline reaches adapters only through
// core/ports.ts, so importing the GitHub adapter fails lint.
import { GitHubGateway } from '../github/GitHubGateway.ts';

export const gateway = GitHubGateway;
