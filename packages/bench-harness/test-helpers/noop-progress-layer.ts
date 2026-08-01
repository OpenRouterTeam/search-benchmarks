import { succeed as layerSucceed } from 'effect/Layer';

import { NOOP_PROGRESS_REPORTER, ProgressReporter } from '../progress';

export const noopProgressLayer = layerSucceed(ProgressReporter, NOOP_PROGRESS_REPORTER);
