import type { LangId } from '../types.js';
import { java } from './java.js';
import { php } from './php.js';
import type { LangPlugin } from './plugin.js';
import { ruby } from './ruby.js';

export type { CallInfo, LangPlugin } from './plugin.js';

export const PLUGINS: Partial<Record<LangId, LangPlugin>> = { java, ruby, php };
