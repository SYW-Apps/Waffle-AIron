/**
 * Portal mounts — src/core/rules/wiring/portal-mounts.ts (portalMountsRule):
 * which listener serves which portal. A portal's routes are its methods'
 * endpoint bindings, but those never said which listener hands it its
 * requests; a listener Portal declares `mounts` — each a portal, the path
 * prefixes routed to it, and optionally the router entry it calls — and the
 * rule holds that declaration to the tree.
 *
 * Documented intents pinned here:
 *  - MOUNT_TARGET_NOT_PORTAL (error): a mount names an unknown component, or
 *    one whose type cannot serve routes — the listener routes requests to
 *    nothing.
 *  - ENDPOINT_OUTSIDE_MOUNT (warning): a mounted portal binds an HTTP endpoint
 *    under none of the prefixes its listener routes to it. A path lies under a
 *    prefix when it EQUALS it or continues it past a slash — so `/booking`
 *    does not cover `/bookings/…`, and `/` covers the root and nothing else.
 *  - UNMOUNTED_PORTAL (warning): a portal declares HTTP endpoints, no listener
 *    mounts it, and it declares no mounts of its own.
 *
 * The quiet shapes, each with a control:
 *  - `/` covers the root: an app shell at `GET /` mounted under `/` is served;
 *  - a listener is marked by DECLARING the field, even as an empty list, so it
 *    is exempt from UNMOUNTED_PORTAL without mounting anything;
 *  - one portal may be mounted by two listeners, each judged on its own
 *    prefixes, and either one makes it reachable;
 *  - only HTTP is judged — a gRPC portal nothing mounts is not a finding,
 *    because a path prefix cannot describe how it is served.
 */
import { defineRuleFixture, type FixtureSpecInput, type FixtureTree } from '../harness.js';

type Endpoint = Record<string, unknown>;

interface Route {
  name: string;
  description: string;
  endpoint: Endpoint;
}

interface PortalShape {
  id: string;
  description: string;
  routes: Route[];
  /** Present (even empty) marks the portal as a listener. */
  mounts?: { portal: string; prefixes: string[]; via?: string }[];
  portalType?: string;
}

const http = (method: string, path: string): Endpoint => ({ transport: 'HTTP', method, path });

/** The clinic's public listener: its own health route, plus whatever it mounts. */
const PUBLIC_LISTENER_ROUTES: Route[] = [
  { name: 'reportHealth', description: 'Report whether the clinic host is serving.', endpoint: http('GET', '/healthz') },
];

/** The patient booking portal: an app shell at the root and the visit routes under /booking. */
const BOOKING_ROUTES: Route[] = [
  { name: 'serveAppShell', description: 'Serve the booking single-page app shell.', endpoint: http('GET', '/') },
  { name: 'bookVisit', description: 'Book a visit for a patient.', endpoint: http('POST', '/booking/visits') },
  { name: 'describeVisit', description: 'Describe one booked visit.', endpoint: http('GET', '/booking/visits/{id}') },
];

/**
 * A clinic host: every portal is an HTTP Portal in the one `clinic` subsystem,
 * with one interface per portal carrying its routes. Extra components (a
 * non-portal a mount might wrongly name) ride along as given.
 */
function clinicTree(portals: PortalShape[], extra: FixtureSpecInput[] = []): FixtureTree {
  return {
    subsystems: [{ id: 'clinic', description: 'Patient booking and referrals for an outpatient clinic.' }],
    components: [
      ...portals.map((p) => ({
        id: p.id,
        componentType: 'Portal',
        portalType: p.portalType ?? 'HTTP_API',
        subsystem: 'clinic',
        description: p.description,
        ...(p.mounts !== undefined ? { mounts: p.mounts } : {}),
      })),
      ...extra.map((c) => ({ subsystem: 'clinic', ...c })),
    ],
    interfaces: portals.map((p) => ({
      id: `i${p.id.replace(/-/g, '_')}`,
      component: p.id,
      methods: p.routes.map((r) => ({ name: r.name, description: r.description, endpoint: r.endpoint })),
    })),
  };
}

const bookingPortal = (routes: Route[] = BOOKING_ROUTES): PortalShape => ({
  id: 'booking-portal',
  description: 'Lets patients book and review their clinic visits.',
  routes,
});

const publicListener = (mounts: PortalShape['mounts']): PortalShape => ({
  id: 'public-listener',
  description: 'The clinic host\'s public HTTP listener; routes each request to the portal that owns its path.',
  routes: PUBLIC_LISTENER_ROUTES,
  mounts,
});

export default [
  // -------------------------------------------------------------------------
  // MOUNT_TARGET_NOT_PORTAL
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MOUNT_TARGET_NOT_PORTAL',
    severity: 'error',
    anchoredTo: 'public-listener',
    expectFire: true,
    scenario:
      'The clinic\'s public listener mounts the visit scheduler under /booking, but the scheduler is an Orchestrator — it has no routes, so every booking request is handed to something that cannot serve it.',
    tree: clinicTree(
      [publicListener([{ portal: 'visit-scheduler', prefixes: ['/booking'] }])],
      [{ id: 'visit-scheduler', componentType: 'Orchestrator', description: 'Finds a free slot for a requested visit.' }],
    ),
  }),
  defineRuleFixture({
    code: 'MOUNT_TARGET_NOT_PORTAL',
    severity: 'error',
    anchoredTo: 'public-listener',
    expectFire: true,
    scenario:
      'The clinic\'s public listener still mounts a referral portal under /referrals that was removed from the design, so referral requests are routed to a component that no longer exists.',
    tree: clinicTree([
      publicListener([
        { portal: 'booking-portal', prefixes: ['/', '/booking'] },
        { portal: 'referral-portal', prefixes: ['/referrals'] },
      ]),
      bookingPortal(),
    ]),
  }),
  defineRuleFixture({
    code: 'MOUNT_TARGET_NOT_PORTAL',
    expectFire: false,
    reason:
      'The listener mounts the booking portal, which is a Portal that exists in the tree — a mount naming something that can serve routes is exactly the declaration the rule asks for.',
    scenario: 'The clinic\'s public listener mounts the booking portal under / and /booking.',
    tree: clinicTree(
      [publicListener([{ portal: 'booking-portal', prefixes: ['/', '/booking'] }]), bookingPortal()],
      [{ id: 'visit-scheduler', componentType: 'Orchestrator', description: 'Finds a free slot for a requested visit.' }],
    ),
  }),

  // -------------------------------------------------------------------------
  // ENDPOINT_OUTSIDE_MOUNT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ENDPOINT_OUTSIDE_MOUNT',
    severity: 'warning',
    anchoredTo: 'public-listener',
    expectFire: true,
    scenario:
      'The booking portal binds its cancellation route to /bookings/cancel while the public listener routes it only /booking — a prefix is matched by path segment, not by characters, so the cancellation route is promised by the contract and reached by no request.',
    tree: clinicTree([
      publicListener([{ portal: 'booking-portal', prefixes: ['/booking'] }]),
      bookingPortal([
        { name: 'bookVisit', description: 'Book a visit for a patient.', endpoint: http('POST', '/booking/visits') },
        { name: 'cancelVisit', description: 'Cancel a booked visit.', endpoint: http('POST', '/bookings/cancel') },
      ]),
    ]),
  }),
  defineRuleFixture({
    code: 'ENDPOINT_OUTSIDE_MOUNT',
    severity: 'warning',
    anchoredTo: 'public-listener',
    expectFire: true,
    scenario:
      'The public listener mounts the booking portal under / alone, expecting the root to catch everything, but / covers only the root itself — the visit routes under /booking are reached by no request.',
    tree: clinicTree([publicListener([{ portal: 'booking-portal', prefixes: ['/'] }]), bookingPortal()]),
  }),
  defineRuleFixture({
    code: 'ENDPOINT_OUTSIDE_MOUNT',
    expectFire: false,
    reason:
      'Every booking route lies under a prefix the listener routes to it: the app shell at GET / equals the prefix /, which covers the root and nothing else, and the visit routes continue /booking past a slash.',
    scenario: 'The public listener mounts the booking portal under / for its app shell and /booking for its visit routes.',
    tree: clinicTree([publicListener([{ portal: 'booking-portal', prefixes: ['/', '/booking'] }]), bookingPortal()]),
  }),
  defineRuleFixture({
    code: 'ENDPOINT_OUTSIDE_MOUNT',
    expectFire: false,
    reason:
      'Each listener is judged on its own mount: the public listener routes the whole booking portal, and the staff listener mounting the same portal under the same prefixes covers every route too. Being mounted twice is allowed.',
    scenario:
      'The booking portal is served both by the clinic\'s public listener and by the staff listener on the internal network, each mounting it under / and /booking.',
    tree: clinicTree([
      publicListener([{ portal: 'booking-portal', prefixes: ['/', '/booking'] }]),
      {
        id: 'staff-listener',
        description: 'The clinic host\'s internal listener for front-desk staff.',
        routes: [{ name: 'reportStaffHealth', description: 'Report whether the staff listener is serving.', endpoint: http('GET', '/staff/healthz') }],
        mounts: [{ portal: 'booking-portal', prefixes: ['/', '/booking'] }],
      },
      bookingPortal(),
    ]),
  }),

  // -------------------------------------------------------------------------
  // UNMOUNTED_PORTAL
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNMOUNTED_PORTAL',
    severity: 'warning',
    anchoredTo: 'referral-portal',
    expectFire: true,
    scenario:
      'The referral portal binds its submission route to POST /referrals, but the public listener mounts only the booking portal — the whole referral surface is something nothing serves.',
    tree: clinicTree([
      publicListener([{ portal: 'booking-portal', prefixes: ['/', '/booking'] }]),
      bookingPortal(),
      {
        id: 'referral-portal',
        description: 'Receives referrals from partner clinics.',
        routes: [{ name: 'submitReferral', description: 'Submit a referral from a partner clinic.', endpoint: http('POST', '/referrals') }],
      },
    ]),
  }),
  defineRuleFixture({
    code: 'UNMOUNTED_PORTAL',
    expectFire: false,
    reason:
      'The listener declares its mounts field, empty because it serves only its own health route, and declaring the field is what marks a listener — the one kind of portal the host starts directly, so nothing else needs to mount it.',
    scenario: 'A small clinic host runs one public listener that serves its health route and mounts no other portal yet.',
    tree: clinicTree([publicListener([])]),
  }),
  defineRuleFixture({
    code: 'UNMOUNTED_PORTAL',
    expectFire: false,
    reason:
      'Both listeners declare their mounts, and the booking portal is mounted by each of them — one portal served by two listeners is allowed, and either mount alone would make it reachable.',
    scenario:
      'The booking portal is served both by the clinic\'s public listener and by the staff listener on the internal network.',
    tree: clinicTree([
      publicListener([{ portal: 'booking-portal', prefixes: ['/', '/booking'] }]),
      {
        id: 'staff-listener',
        description: 'The clinic host\'s internal listener for front-desk staff.',
        routes: [{ name: 'reportStaffHealth', description: 'Report whether the staff listener is serving.', endpoint: http('GET', '/staff/healthz') }],
        mounts: [{ portal: 'booking-portal', prefixes: ['/', '/booking'] }],
      },
      bookingPortal(),
    ]),
  }),
  defineRuleFixture({
    code: 'UNMOUNTED_PORTAL',
    expectFire: false,
    reason:
      'The lab-results portal speaks gRPC only. Mounts route HTTP paths, and a path prefix cannot describe how a gRPC service is served, so a portal with no HTTP endpoints is outside the rule rather than unreachable.',
    scenario:
      'The clinic exposes lab results to the hospital network as a gRPC service beside its public HTTP listener, and no listener mounts it.',
    tree: clinicTree([
      publicListener([]),
      {
        id: 'lab-results-portal',
        description: 'Streams lab results to the hospital network.',
        portalType: 'gRPC',
        routes: [
          {
            name: 'fetchLabResult',
            description: 'Fetch one lab result for a patient.',
            endpoint: { transport: 'gRPC', service: 'LabResults', method: 'FetchLabResult' },
          },
        ],
      },
    ]),
  }),
];
