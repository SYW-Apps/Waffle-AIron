/**
 * Lifecycle-entrypoint family (src/core/rules/semantic-edges.ts,
 * lifecycleRule): declared init/shutdown/scheduled flow roots must name an
 * existing component and a method on one of its interfaces — they are
 * reachability roots, so a dangling entrypoint would silently detach every
 * flow rooted in it.
 *
 * Documented intents pinned here:
 *  - INVALID_LIFECYCLE_ENTRYPOINT (error): the entrypoint names a missing
 *    component or a method the component's interfaces do not declare.
 *  - LIFECYCLE_CROSS_SUBSYSTEM (error): a lifecycle flow is the subsystem's
 *    OWN boot/shutdown wiring — rooting it in a sibling's component crosses
 *    the boundary; declare it on the owning subsystem instead.
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // INVALID_LIFECYCLE_ENTRYPOINT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_LIFECYCLE_ENTRYPOINT',
    severity: 'error',
    anchoredTo: 'catalog-search',
    expectFire: true,
    scenario:
      'The catalog-search subsystem roots its init flow in search-index-warmer.warmAll, but the warmer\'s contract only declares warmTopSellers — the boot flow dangles.',
    tree: {
      subsystems: [
        {
          id: 'catalog-search',
          description: 'Product search over the catalog index.',
          lifecycle: [
            {
              phase: 'init',
              component: 'search-index-warmer',
              method: 'warmAll',
              description: 'Warm the search index before serving queries.',
            },
          ],
        },
      ],
      components: [
        {
          id: 'search-index-warmer',
          componentType: 'Actor',
          description: 'Preloads hot search index segments at boot.',
        },
      ],
      interfaces: [
        {
          id: 'isearch_index_warmer',
          component: 'search-index-warmer',
          methods: [{ name: 'warmTopSellers', description: 'Preload index segments for the top-selling categories.' }],
        },
      ],
      implementations: [
        {
          id: 'search_index_warmer_impl',
          contract: 'isearch_index_warmer',
          methods: [
            {
              name: 'warmTopSellers',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Load the top-seller index segments into memory.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_LIFECYCLE_ENTRYPOINT',
    expectFire: false,
    reason: 'The entrypoint names a method the warmer\'s interface really declares, so the boot flow has a real root.',
    scenario:
      'The catalog-search subsystem roots its init flow in the warmer\'s declared warmTopSellers method.',
    tree: {
      subsystems: [
        {
          id: 'catalog-search',
          description: 'Product search over the catalog index.',
          lifecycle: [
            {
              phase: 'init',
              component: 'search-index-warmer',
              method: 'warmTopSellers',
              description: 'Warm the search index before serving queries.',
            },
          ],
        },
      ],
      components: [
        {
          id: 'search-index-warmer',
          componentType: 'Actor',
          description: 'Preloads hot search index segments at boot.',
        },
      ],
      interfaces: [
        {
          id: 'isearch_index_warmer',
          component: 'search-index-warmer',
          methods: [{ name: 'warmTopSellers', description: 'Preload index segments for the top-selling categories.' }],
        },
      ],
      implementations: [
        {
          id: 'search_index_warmer_impl',
          contract: 'isearch_index_warmer',
          methods: [
            {
              name: 'warmTopSellers',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Load the top-seller index segments into memory.' }],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // LIFECYCLE_CROSS_SUBSYSTEM
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'LIFECYCLE_CROSS_SUBSYSTEM',
    severity: 'error',
    anchoredTo: 'storefront',
    expectFire: true,
    scenario:
      'The storefront subsystem declares an init entrypoint on the price-cache warmer, but that warmer belongs to the pricing subsystem — the boot wiring reaches across the boundary.',
    tree: {
      subsystems: [
        {
          id: 'storefront',
          description: 'Customer-facing shop pages.',
          lifecycle: [
            {
              phase: 'init',
              component: 'price-cache-warmer',
              method: 'warmPrices',
              description: 'Preload the price cache before serving shop pages.',
            },
          ],
        },
        { id: 'pricing', description: 'Price computation and caching.' },
      ],
      components: [
        {
          id: 'price-cache-warmer',
          componentType: 'Actor',
          subsystem: 'pricing',
          description: 'Preloads the price cache from the pricing engine.',
        },
      ],
      interfaces: [
        {
          id: 'iprice_cache_warmer',
          component: 'price-cache-warmer',
          methods: [{ name: 'warmPrices', description: 'Preload current prices for the active catalog.' }],
        },
      ],
      implementations: [
        {
          id: 'price_cache_warmer_impl',
          contract: 'iprice_cache_warmer',
          methods: [
            {
              name: 'warmPrices',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Load current prices for the active catalog into the cache.' }],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'LIFECYCLE_CROSS_SUBSYSTEM',
    expectFire: false,
    reason: 'The owning pricing subsystem declares the entrypoint itself, so the boot wiring stays inside its boundary.',
    scenario:
      'The pricing subsystem declares the init entrypoint for its own price-cache warmer.',
    tree: {
      subsystems: [
        { id: 'storefront', description: 'Customer-facing shop pages.' },
        {
          id: 'pricing',
          description: 'Price computation and caching.',
          lifecycle: [
            {
              phase: 'init',
              component: 'price-cache-warmer',
              method: 'warmPrices',
              description: 'Preload the price cache before serving shop pages.',
            },
          ],
        },
      ],
      components: [
        {
          id: 'price-cache-warmer',
          componentType: 'Actor',
          subsystem: 'pricing',
          description: 'Preloads the price cache from the pricing engine.',
        },
      ],
      interfaces: [
        {
          id: 'iprice_cache_warmer',
          component: 'price-cache-warmer',
          methods: [{ name: 'warmPrices', description: 'Preload current prices for the active catalog.' }],
        },
      ],
      implementations: [
        {
          id: 'price_cache_warmer_impl',
          contract: 'iprice_cache_warmer',
          methods: [
            {
              name: 'warmPrices',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Load current prices for the active catalog into the cache.' }],
            },
          ],
        },
      ],
    },
  }),
];
