/**
 * Rule family: external links.
 *
 * Codes covered:
 *  - external-links (src/core/rules/integrity/external-links.ts):
 *    EXTERNAL_LINK_UNSAFE (error) — a component's external link must be an
 *    absolute https URL (http only for localhost / 127.0.0.1) without
 *    credentials, since it is rendered as a clickable link.
 */
import { defineRuleFixture } from '../harness.js';

const subsystems = [{ id: 'ops-docs', description: 'Runbooks and dashboards for the on-call team.' }];

export default [
  defineRuleFixture({
    code: 'EXTERNAL_LINK_UNSAFE',
    severity: 'error',
    anchoredTo: 'pager-runbook',
    expectFire: true,
    scenario:
      'An on-call runbook component links its dashboard with a javascript: url, which a reader would run when clicking the link.',
    tree: {
      subsystems,
      components: [
        {
          id: 'pager-runbook',
          componentType: 'Orchestrator',
          subsystem: 'ops-docs',
          description: 'Walks the on-call engineer through the paging runbook.',
          externalLinks: [{ url: 'javascript:alert(1)', type: 'informative', label: 'Dashboard' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'EXTERNAL_LINK_UNSAFE',
    expectFire: false,
    reason: 'Both links are absolute https or localhost http URLs without credentials.',
    scenario: 'The runbook links its dashboard over https and a local preview over http on localhost.',
    tree: {
      subsystems,
      components: [
        {
          id: 'pager-runbook',
          componentType: 'Orchestrator',
          subsystem: 'ops-docs',
          description: 'Walks the on-call engineer through the paging runbook.',
          externalLinks: [
            { url: 'https://dashboards.example.com/oncall', type: 'informative', label: 'Dashboard' },
            { url: 'http://localhost:8080/preview', type: 'informative' },
          ],
        },
      ],
    },
  }),
];
