/** Entry point of the S16 extension modules; `TASKS_EXTENSION_READY` gates the advertisement (§3.2). */
import { CreateTaskResultSchema, GetTaskResultSchema } from './schema.js';
import { McpTasksService } from './service.js';

export { TASKS_EXTENSION_ID, missingTasksCapability, parseTasksCapability } from './capability.js';
export { TASK_METHODS, validateTaskMethodHeaders } from './headers.js';
export { McpTasksService } from './service.js';

export const TASKS_EXTENSION_READY: boolean =
  typeof McpTasksService.prototype.get === 'function' &&
  typeof McpTasksService.prototype.update === 'function' &&
  typeof McpTasksService.prototype.cancel === 'function' &&
  CreateTaskResultSchema !== undefined &&
  GetTaskResultSchema !== undefined;
