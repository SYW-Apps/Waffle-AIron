/**
 * Route coverage (code↔contract for the ROUTES) — src/core/rules/conformance/route-coverage.ts.
 *
 * Documented intents pinned here (rule description + module doc comment):
 *  - UNDECLARED_ROUTE (warning): a router answers a route no contract endpoint
 *    of the portal it serves declares — a surface the code serves and the
 *    design never promised, which is how a write ran with no contract.
 *  - UNROUTED_ENDPOINT (warning): a contract endpoint no route of the portal's
 *    router answers — the contract promises a route no request can reach.
 *  - UNREADABLE_ROUTER (warning): the router a listener's mount names yields
 *    no route in the one idiom read, so its routes were not checked at all —
 *    reported as unread, never passed.
 *
 * The quiet shapes, each with a control that is ONE mechanism away from
 * firing:
 *  - ROUTERS NEST: a route only fully formed by an ENCLOSING `if` — the outer
 *    guard fixes the resource segment, the inner one the verb and count — is
 *    read as the conjunction of both, so it matches its endpoint;
 *  - THE LEADING SEGMENT COMES FROM THE MOUNT: the router never checks
 *    `parts[0]`, and the mount's prefix is what completes it;
 *  - an endpoint's TEMPLATE segment (`{visitId}`) is answered by a route
 *    segment nothing constrains;
 *  - a route that pins no segment count covers a longer endpoint path under
 *    the same leading segments;
 *  - a mount with no `via` calls the portal's methods directly and has no
 *    router to read, so neither an undeclared route in the portal's file nor
 *    a file written outside the idiom is judged.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

interface BookingEndpoint {
  name: string;
  description: string;
  method: string;
  path: string;
}

const BOOK_VISIT: BookingEndpoint = {
  name: 'bookVisit',
  description: 'Book a visit for a patient.',
  method: 'POST',
  path: '/booking/visits',
};
const DESCRIBE_VISIT: BookingEndpoint = {
  name: 'describeVisit',
  description: 'Describe one booked visit.',
  method: 'GET',
  path: '/booking/visits/{visitId}',
};
const LIST_VISITS: BookingEndpoint = {
  name: 'listVisits',
  description: 'List the visits booked for the signed-in patient.',
  method: 'GET',
  path: '/booking/visits',
};

/** The request shape every router below reads, and the handlers it dispatches to. */
const ROUTER_PRELUDE = [
  'export interface BookingRequest { method: string; url: string; body: string; }',
  '',
  'export function bookVisit(patient: string): string {',
  '  return \'visit:\' + patient;',
  '}',
  '',
  'export function describeVisit(visitId: string): string {',
  '  return \'visit \' + visitId;',
  '}',
  '',
];

/** A router written in the idiom: its body lines go between the path split and the fall-through. */
function router(body: string[]): string {
  return [
    ...ROUTER_PRELUDE,
    'export function handleBookingRequest(req: BookingRequest): string | undefined {',
    '  const parts = req.url.split(\'/\').filter(Boolean);',
    ...body.map(line => `  ${line}`),
    '  return undefined;',
    '}',
    '',
  ].join('\n');
}

/**
 * The booking portal's router as it should be: the OUTER guard fixes the
 * resource segment, the inner ones the verb and the segment count, and
 * nothing checks `parts[0]` — the listener routed `/booking` here already.
 */
const NESTED_ROUTES = [
  'if (parts[1] === \'visits\') {',
  '  if (req.method === \'POST\' && parts.length === 2) return bookVisit(req.body);',
  '  if (req.method === \'GET\' && parts.length === 3) return describeVisit(parts[2]);',
  '}',
];

/**
 * A clinic host whose public listener mounts the booking portal under
 * `/booking` through the router entry `handleBookingRequest` that the booking
 * portal's module exports — or, given `null`, with no `via` at all. Everything but the portal's endpoints,
 * its module and the mount's `via` is identical from tree to tree.
 */
function bookingTree(endpoints: BookingEndpoint[], bookingModule: string, via: string | null = 'handleBookingRequest'): FixtureTree {
  return {
    subsystems: [{ id: 'clinic', description: 'Patient booking for an outpatient clinic.' }],
    components: [
      {
        id: 'clinic-listener',
        componentType: 'Portal',
        portalType: 'HTTP_API',
        subsystem: 'clinic',
        description: 'The clinic host\'s public HTTP listener; routes each request to the portal that owns its path.',
        mounts: [{ portal: 'booking-portal', prefixes: ['/booking'], ...(via ? { via } : {}) }],
      },
      {
        id: 'booking-portal',
        componentType: 'Portal',
        portalType: 'HTTP_API',
        subsystem: 'clinic',
        description: 'Lets patients book and review their clinic visits.',
      },
    ],
    interfaces: [
      {
        id: 'iclinic_listener',
        component: 'clinic-listener',
        methods: [{
          name: 'reportHealth',
          description: 'Report whether the clinic host is serving.',
          endpoint: { transport: 'HTTP', method: 'GET', path: '/healthz' },
        }],
      },
      {
        id: 'ibooking_portal',
        component: 'booking-portal',
        methods: endpoints.map(endpoint => ({
          name: endpoint.name,
          description: endpoint.description,
          endpoint: { transport: 'HTTP', method: endpoint.method, path: endpoint.path },
        })),
      },
    ],
    implementations: [
      {
        id: 'clinic_listener_impl',
        contract: 'iclinic_listener',
        sourcePath: 'src/clinic/listener.ts',
        methods: [{
          name: 'reportHealth',
          narrative: [{ stepNumber: 1, type: 'local', description: 'Answer that the clinic host is serving.' }],
        }],
      },
      {
        id: 'booking_portal_impl',
        contract: 'ibooking_portal',
        sourcePath: 'src/clinic/booking-portal.ts',
        methods: endpoints.map(endpoint => ({
          name: endpoint.name,
          narrative: [{ stepNumber: 1, type: 'local', description: `${endpoint.description.replace(/\.$/, '')} from the request.` }],
        })),
      },
    ],
    files: {
      'src/clinic/booking-portal.ts': bookingModule,
      'src/clinic/listener.ts': [
        'import { handleBookingRequest, type BookingRequest } from \'./booking-portal.js\';',
        '',
        'export function reportHealth(): string {',
        '  return \'ok\';',
        '}',
        '',
        'export function route(req: BookingRequest): string | undefined {',
        '  return req.url.startsWith(\'/booking/\') ? handleBookingRequest(req) : reportHealth();',
        '}',
        '',
      ].join('\n'),
    },
  };
}

/** A booking router written OUTSIDE the idiom: it compares the whole path, never its split segments. */
const WHOLE_PATH_ROUTER = [
  ...ROUTER_PRELUDE,
  'export function handleBookingRequest(req: BookingRequest): string | undefined {',
  '  switch (`${req.method} ${req.url}`) {',
  '    case \'POST /booking/visits\': return bookVisit(req.body);',
  '    default: return undefined;',
  '  }',
  '}',
  '',
].join('\n');

/** The nested router plus a cancellation route no contract declares — a write. */
const WITH_CANCELLATION = router([
  ...NESTED_ROUTES.slice(0, 3),
  '  if (req.method === \'DELETE\' && parts.length === 3) return \'cancelled \' + parts[2];',
  '}',
]);

export default [
  // -------------------------------------------------------------------------
  // UNDECLARED_ROUTE — fire: the router serves a write no contract declares.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_ROUTE',
    severity: 'warning',
    anchoredTo: 'booking_portal_impl',
    expectFire: true,
    scenario:
      'The booking portal\'s router, mounted by the clinic listener, also answers DELETE /booking/visits/{visitId} and cancels the visit — a write no contract of the booking portal declares, so no brief and no review ever read it.',
    tree: bookingTree([BOOK_VISIT, DESCRIBE_VISIT], WITH_CANCELLATION),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_ROUTE — control: NESTED routers. Each route is only fully
  // formed by the enclosing `if` on the resource segment.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_ROUTE',
    expectFire: false,
    reason:
      'The resource segment is fixed by the OUTER guard and the verb and count by the inner one; the route is the conjunction of both. Reading only the inner guard would turn POST /booking/visits into POST /booking/* and report it.',
    scenario:
      'The booking portal\'s router checks the visits segment once and dispatches booking a visit inside that branch, exactly as its contract declares.',
    tree: bookingTree([BOOK_VISIT], router([
      'if (parts[1] === \'visits\') {',
      '  if (req.method === \'POST\' && parts.length === 2) return bookVisit(req.body);',
      '}',
    ])),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_ROUTE — control: the leading segment comes from the MOUNT.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_ROUTE',
    expectFire: false,
    reason:
      'The router never checks the first segment — the listener routed /booking to it already — so the mount\'s prefix completes it. Without that the route reads as POST /*/visits, which no endpoint declares.',
    scenario:
      'The booking portal\'s flat router answers POST on the visits collection without re-checking the /booking segment its listener mounts it under.',
    tree: bookingTree([BOOK_VISIT], router([
      'if (req.method === \'POST\' && parts[1] === \'visits\' && parts.length === 2) return bookVisit(req.body);',
    ])),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_ROUTE — control: a TEMPLATE endpoint segment is answered by a
  // route segment nothing constrains.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_ROUTE',
    expectFire: false,
    reason:
      'The contract\'s {visitId} is a template parameter and the router leaves the third segment unconstrained: both are one wildcard. Comparing them as written would report GET /booking/visits/* as undeclared.',
    scenario:
      'The booking portal\'s router answers GET on one visit by its id, which the contract declares as /booking/visits/{visitId}.',
    tree: bookingTree([DESCRIBE_VISIT], router([
      'if (req.method === \'GET\' && parts[1] === \'visits\' && parts.length === 3) return describeVisit(parts[2]);',
    ])),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_ROUTE — control: a mount with no `via` has no router to read.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_ROUTE',
    expectFire: false,
    reason:
      'The mount names no router entry: the listener calls the booking portal\'s contract methods directly, so the portal\'s module holds no router this rule is asked to read — the very file that fires with `via` set stays quiet without it.',
    scenario:
      'The clinic listener calls the booking portal\'s methods one by one rather than through a router entry, and the portal\'s module still carries an old cancellation branch.',
    tree: bookingTree([BOOK_VISIT, DESCRIBE_VISIT], WITH_CANCELLATION, null),
  }),

  // -------------------------------------------------------------------------
  // UNROUTED_ENDPOINT — fire: the contract promises a route the router lacks.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNROUTED_ENDPOINT',
    severity: 'warning',
    anchoredTo: 'booking_portal_impl',
    expectFire: true,
    scenario:
      'The booking portal\'s contract declares GET /booking/visits to list a patient\'s visits, but its router only books a visit and describes one — no request can reach the listing.',
    tree: bookingTree([BOOK_VISIT, DESCRIBE_VISIT, LIST_VISITS], router(NESTED_ROUTES)),
  }),

  // -------------------------------------------------------------------------
  // UNROUTED_ENDPOINT — control: every endpoint has a route.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNROUTED_ENDPOINT',
    expectFire: false,
    reason: 'Every endpoint the contract binds is answered by a route of the router, which is the whole of the claim.',
    scenario: 'The booking portal\'s router books a visit and describes one, the two routes its contract declares.',
    tree: bookingTree([BOOK_VISIT, DESCRIBE_VISIT], router(NESTED_ROUTES)),
  }),

  // -------------------------------------------------------------------------
  // UNROUTED_ENDPOINT — control: a route that pins no segment count covers a
  // longer path under it.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNROUTED_ENDPOINT',
    expectFire: false,
    reason:
      'The GET branch checks the visits segment but not how many follow, so the router may read past it: it answers /booking/visits/{visitId}. Requiring equal length would report the endpoint as unrouted.',
    scenario:
      'The booking portal\'s router hands every GET under the visits collection to one branch that reads the visit id itself.',
    tree: bookingTree([DESCRIBE_VISIT], router([
      'if (req.method === \'GET\' && parts[1] === \'visits\') return describeVisit(parts[2]);',
    ])),
  }),

  // -------------------------------------------------------------------------
  // UNREADABLE_ROUTER — fire: the mounted router is written outside the idiom.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREADABLE_ROUTER',
    severity: 'warning',
    anchoredTo: 'booking_portal_impl',
    expectFire: true,
    scenario:
      'The clinic listener mounts the booking portal through handleBookingRequest, which dispatches on the whole method-and-path string — no route can be read out of it, so its routes are checked against nothing.',
    tree: bookingTree([BOOK_VISIT], WHOLE_PATH_ROUTER),
  }),

  // -------------------------------------------------------------------------
  // UNREADABLE_ROUTER — control: a router in the idiom is read.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREADABLE_ROUTER',
    expectFire: false,
    reason: 'The router compares the method and the split path\'s segments, which is the idiom read, so its routes are judged rather than reported as unread.',
    scenario: 'The clinic listener mounts the booking portal through handleBookingRequest, a router that checks the method and each path segment.',
    tree: bookingTree([BOOK_VISIT, DESCRIBE_VISIT], router(NESTED_ROUTES)),
  }),

  // -------------------------------------------------------------------------
  // UNREADABLE_ROUTER — control: a mount with no `via` has no router at all.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREADABLE_ROUTER',
    expectFire: false,
    reason:
      'Without a `via` the listener calls the portal\'s methods directly, so there is no router to have failed to read — the same module that fires when the mount names it stays quiet when the mount does not.',
    scenario:
      'The clinic listener calls the booking portal\'s methods one by one, and the portal\'s module keeps a whole-path dispatcher nothing mounts.',
    tree: bookingTree([BOOK_VISIT], WHOLE_PATH_ROUTER, null),
  }),
];
