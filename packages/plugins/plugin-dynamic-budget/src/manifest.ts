import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';
const manifest: PaperclipPluginManifestV1 = {
  id: 'smarty.dynamic-budget', apiVersion: 1, version: '0.1.2',
  displayName: 'Budget', author: 'Smarty Pants', categories: ['ui'],
  description: 'One read-only budget picture. No holds, agent changes, purchases, or routing effects.',
  capabilities: ['ui.page.register', 'ui.sidebar.register', 'ui.dashboardWidget.register', 'database.namespace.read', 'database.namespace.migrate'],
  entrypoints: { worker: './dist/worker.js', ui: './dist/ui' },
  database: { migrationsDir: 'migrations', coreReadTables: ['cost_events', 'heartbeat_runs'] },
  instanceConfigSchema: {
    type: 'object', additionalProperties: false,
    properties: { importJson: { type: 'string', title: 'Validated budget import (company-specific)', description: 'Schema 1 JSON with matching companyId, exact USD amounts, coverage keys, sources and observation times. Missing inputs stay unknown.', maxLength: 1000000 } },
  },
  ui: { slots: [
    { type: 'page', id: 'budget', displayName: 'Budget', exportName: 'BudgetPage', routePath: 'dynamic-budget' },
    { type: 'sidebar', id: 'budget-sidebar', displayName: 'Budget', exportName: 'BudgetSidebar' },
    { type: 'dashboardWidget', id: 'budget-summary', displayName: 'Budget', exportName: 'BudgetWidget' },
  ] },
};
export default manifest;
