import { DISCLOSURE } from './capture.mjs';

export const TOOL = {
  name: 'screen.capture',
  displayName: 'Screen capture',
  description: `Only Paul's primary Smarty, in his own conversation. ${DISCLOSURE} This build uses a stub: it never captures a screen.`,
  parametersSchema: {
    type: 'object',
    properties: { windowApp: { type: 'string', description: 'Optional app bundle ID.' } },
    additionalProperties: false,
  },
};

export default {
  id: 'smarty.screen-capture',
  apiVersion: 1,
  version: '0.1.0',
  displayName: 'Smarty Screen Capture (stub)',
  description: 'Company-scoped, person-message-bound capture policy and refusal audit; no Mac or token issuance.',
  author: 'Smarty Pants',
  categories: ['connector'],
  capabilities: [
    'agent.tools.register', 'database.namespace.migrate',
    'database.namespace.read', 'database.namespace.write',
  ],
  entrypoints: { worker: './worker.mjs' },
  database: {
    namespaceSlug: 'screen_capture',
    migrationsDir: 'migrations',
    coreReadTables: ['agents', 'issues', 'issue_comments', 'heartbeat_runs'],
  },
  instanceConfigSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['companyId', 'principalUserId', 'primaryAgentId'],
    properties: {
      companyId: { type: 'string', format: 'uuid', description: 'Board-selected company; no cross-company capture.' },
      principalUserId: { type: 'string', minLength: 1, description: 'Structured principal user ID (stand-in ID in TEST).' },
      primaryAgentId: { type: 'string', format: 'uuid', description: 'Board-pinned primary Smarty; never a hire.' },
    },
  },
  tools: [TOOL],
};
