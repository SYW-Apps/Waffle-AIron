/**
 * Portal field + endpoint-binding fixtures (portalFieldsRule in
 * src/core/rules/intrinsic/portal-fields.ts, portalsRule in
 * src/core/rules/doctrine/portal-endpoints.ts, nonPortalEndpointsRule in
 * src/core/rules/doctrine/non-portal-endpoints.ts).
 *
 * Documented intents pinned here:
 *  - MISSING_PORTAL_TRANSPORT (error): a Portal declares its transport (the
 *    retired MISSING_PORTAL_TYPE, renamed with the reachability model).
 *  - UNEXPECTED_PORTAL_FIELD (error): non-Portal components carry no
 *    transport (the retired portalType reads as it) or basePath — both
 *    behaviors get a fire — and only an InProcess Portal carries an abi.
 *  - AUTH_ON_NON_PORTAL (warning): auth is inbound transport auth, only
 *    meaningful on a Portal; a gateway is a Portal with the gateway variant, so
 *    it carries the auth itself, never the Orchestrator it dispatches to.
 *  - MISSING_ENDPOINT (error): a Portal whose portalType maps to a transport
 *    binds every interface method to a concrete endpoint.
 *  - ENDPOINT_TRANSPORT_MISMATCH (error): the endpoint's transport must match
 *    the Portal's portalType.
 *  - ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT (error): only Portal
 *    components may carry endpoints on their interface methods.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, patient records, and partner integrations.',
};

const SCHEDULING_SUB = { id: 'scheduling', description: 'Appointment booking and slot management.' };

export default [
  // -------------------------------------------------------------------------
  // MISSING_PORTAL_TRANSPORT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_PORTAL_TRANSPORT',
    severity: 'error',
    anchoredTo: 'patient-booking-portal',
    expectFire: true,
    scenario:
      'The patient booking portal is declared as a Portal but never states which transport (HTTP, gRPC, CLI, InProcess, ...) its callers reach it over.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'patient-booking-portal', componentType: 'Portal', description: 'Patient-facing surface for booking visits.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_PORTAL_TRANSPORT',
    expectFire: false,
    reason: 'The Portal declares its transport (HTTP), which is all this completeness code demands.',
    scenario:
      'The patient booking portal declares that its callers reach it over HTTP.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'patient-booking-portal', componentType: 'Portal', transport: 'HTTP', description: 'Patient-facing surface for booking visits.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_PORTAL_TRANSPORT',
    expectFire: false,
    reason: 'A stored file still spelling the retired portalType HTTP_API is read as transport HTTP for one release, so it declares its transport.',
    scenario:
      'The patient booking portal was written before the reachability model and still declares portalType HTTP_API.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'patient-booking-portal', componentType: 'Portal', portalType: 'HTTP_API', description: 'Patient-facing surface for booking visits.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNEXPECTED_PORTAL_FIELD',
    severity: 'error',
    anchoredTo: 'patient-booking-portal',
    expectFire: true,
    scenario:
      'The patient booking portal is an HTTP API but declares abi c, as if foreign languages linked it as a shared library.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'patient-booking-portal', componentType: 'Portal', transport: 'HTTP', abi: 'c', description: 'Patient-facing surface for booking visits.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNEXPECTED_PORTAL_FIELD',
    expectFire: false,
    reason: 'An abi says how a foreign language links a library, and the slot-math library is an InProcess Portal: the one place an abi belongs.',
    scenario:
      'The slot arithmetic library is an InProcess Portal that declares abi c so the clinic kiosk firmware can link it as a C shared library.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'slot-arithmetic-library', componentType: 'Portal', transport: 'InProcess', abi: 'c', description: 'Slot arithmetic exposed to firmware over a C ABI.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNEXPECTED_PORTAL_FIELD — both documented fields
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNEXPECTED_PORTAL_FIELD',
    severity: 'error',
    anchoredTo: 'billing-export-orchestrator',
    expectFire: true,
    scenario:
      'The billing export orchestrator carries a portalType although it is an Orchestrator, not a Portal.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'billing', description: 'Invoicing and payment collection for booked visits.' }],
      components: [
        {
          id: 'billing-export-orchestrator',
          componentType: 'Orchestrator',
          portalType: 'HTTP_API',
          description: 'Drives the nightly billing export run.',
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNEXPECTED_PORTAL_FIELD',
    severity: 'error',
    anchoredTo: 'invoice-archive-store',
    expectFire: true,
    scenario:
      'The invoice archive store carries a basePath as if it exposed a wire surface, but basePath is a Portal-only field.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'billing', description: 'Invoicing and payment collection for booked visits.' }],
      components: [
        {
          id: 'invoice-archive-store',
          componentType: 'Store',
          basePath: '/invoices',
          description: 'Holds archived invoices for audit retrieval.',
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNEXPECTED_PORTAL_FIELD',
    expectFire: false,
    reason: 'The non-Portal component carries neither portalType nor basePath; the wire fields live on the Portal that exposes the surface.',
    scenario:
      'The billing export orchestrator carries no wire fields, and the invoice API portal owns the basePath of the billing surface.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'billing', description: 'Invoicing and payment collection for booked visits.' }],
      components: [
        { id: 'billing-export-orchestrator', componentType: 'Orchestrator', description: 'Drives the nightly billing export run.' },
        { id: 'invoice-api-portal', componentType: 'Portal', portalType: 'HTTP_API', basePath: '/invoices', description: 'Inbound invoicing surface of the billing subsystem.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // AUTH_ON_NON_PORTAL — the documented gateway example, literally
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'AUTH_ON_NON_PORTAL',
    severity: 'warning',
    anchoredTo: 'partner-request-orchestrator',
    expectFire: true,
    scenario:
      'The partner request orchestrator declares the apiKey auth scheme on itself instead of on the partner API gateway portal that exposes the surface, so the OpenAPI projection would ignore it.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'partner-integrations', description: 'Partner clinic and lab integrations.' }],
      components: [
        {
          id: 'partner-api-gateway',
          componentType: 'Portal',
          portalType: 'Custom',
          variant: 'gateway',
          description: 'Front door for partner requests, dispatching to the partner request orchestrator.',
          dependsOn: ['partner-request-orchestrator'],
        },
        {
          id: 'partner-request-orchestrator',
          componentType: 'Orchestrator',
          description: 'Drives partner-initiated request flows.',
          auth: { scheme: 'apiKey', in: 'header', name: 'X-Partner-Key' },
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'AUTH_ON_NON_PORTAL',
    expectFire: false,
    reason: 'Auth sits on the exposed Portal — the gateway is a Portal with the gateway variant, so it carries the auth itself.',
    scenario:
      'The partner API gateway portal declares the apiKey scheme on the surface it exposes, and the partner request orchestrator behind it declares none.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'partner-integrations', description: 'Partner clinic and lab integrations.' }],
      components: [
        {
          id: 'partner-api-gateway',
          componentType: 'Portal',
          portalType: 'Custom',
          variant: 'gateway',
          description: 'Front door for partner requests, dispatching to the partner request orchestrator.',
          dependsOn: ['partner-request-orchestrator'],
          auth: { scheme: 'apiKey', in: 'header', name: 'X-Partner-Key' },
        },
        { id: 'partner-request-orchestrator', componentType: 'Orchestrator', description: 'Drives partner-initiated request flows.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MISSING_ENDPOINT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_ENDPOINT',
    severity: 'error',
    anchoredTo: 'ipatient_booking',
    expectFire: true,
    scenario:
      'The HTTP patient booking portal\'s bookVisit contract method has no endpoint binding, so no wire route exists for it.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'patient-booking-portal', componentType: 'Portal', portalType: 'HTTP_API', description: 'Patient-facing surface for booking visits.' },
      ],
      interfaces: [
        {
          id: 'ipatient_booking',
          component: 'patient-booking-portal',
          methods: [{ name: 'bookVisit', description: 'Book a visit for a patient.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_ENDPOINT',
    expectFire: false,
    reason: 'Every interface method of the HTTP portal is bound to a concrete HTTP endpoint of the matching transport.',
    scenario:
      'The HTTP patient booking portal binds bookVisit to POST /visits.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'patient-booking-portal', componentType: 'Portal', portalType: 'HTTP_API', description: 'Patient-facing surface for booking visits.' },
      ],
      interfaces: [
        {
          id: 'ipatient_booking',
          component: 'patient-booking-portal',
          methods: [
            {
              name: 'bookVisit',
              description: 'Book a visit for a patient.',
              endpoint: { transport: 'HTTP', method: 'POST', path: '/visits' },
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // ENDPOINT_TRANSPORT_MISMATCH
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ENDPOINT_TRANSPORT_MISMATCH',
    severity: 'error',
    anchoredTo: 'ireferral_exchange',
    expectFire: true,
    scenario:
      'The referral exchange portal is declared gRPC, but its submitReferral method still carries the old HTTP endpoint binding.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'referrals', description: 'Inter-clinic referral exchange.' }],
      components: [
        { id: 'referral-exchange-portal', componentType: 'Portal', portalType: 'gRPC', description: 'Inbound referral exchange surface.' },
      ],
      interfaces: [
        {
          id: 'ireferral_exchange',
          component: 'referral-exchange-portal',
          methods: [
            {
              name: 'submitReferral',
              description: 'Submit a referral to the receiving clinic.',
              endpoint: { transport: 'HTTP', method: 'POST', path: '/referrals' },
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'ENDPOINT_TRANSPORT_MISMATCH',
    expectFire: false,
    reason: 'The endpoint\'s transport (gRPC) matches the Portal\'s portalType (gRPC).',
    scenario:
      'The gRPC referral exchange portal binds submitReferral to the ReferralExchange service\'s SubmitReferral rpc.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'referrals', description: 'Inter-clinic referral exchange.' }],
      components: [
        { id: 'referral-exchange-portal', componentType: 'Portal', portalType: 'gRPC', description: 'Inbound referral exchange surface.' },
      ],
      interfaces: [
        {
          id: 'ireferral_exchange',
          component: 'referral-exchange-portal',
          methods: [
            {
              name: 'submitReferral',
              description: 'Submit a referral to the receiving clinic.',
              endpoint: { transport: 'gRPC', service: 'ReferralExchange', method: 'SubmitReferral' },
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT',
    severity: 'error',
    anchoredTo: 'iclaims_scoring',
    expectFire: true,
    scenario:
      'The claims scoring arbiter\'s contract method declares an HTTP endpoint although only Portal components may carry wire endpoints.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.' }],
      components: [
        { id: 'claims-scoring-arbiter', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Scores a claim against the payer\'s adjudication rules.' },
      ],
      interfaces: [
        {
          id: 'iclaims_scoring',
          component: 'claims-scoring-arbiter',
          methods: [
            {
              name: 'scoreClaim',
              description: 'Score one claim for adjudication.',
              endpoint: { transport: 'HTTP', method: 'POST', path: '/claims/score' },
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT',
    expectFire: false,
    reason: 'The arbiter\'s contract carries no endpoint; wire bindings belong to the Portal that exposes the capability.',
    scenario:
      'The claims scoring arbiter exposes scoreClaim as a plain in-process contract method with no wire endpoint.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.' }],
      components: [
        { id: 'claims-scoring-arbiter', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Scores a claim against the payer\'s adjudication rules.' },
      ],
      interfaces: [
        {
          id: 'iclaims_scoring',
          component: 'claims-scoring-arbiter',
          methods: [{ name: 'scoreClaim', description: 'Score one claim for adjudication.' }],
        },
      ],
    },
  }),
  // -------------------------------------------------------------------------
  // ENDPOINT_ROUTE_DUPLICATE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ENDPOINT_ROUTE_DUPLICATE',
    severity: 'error',
    anchoredTo: 'ibooking_api',
    expectFire: true,
    scenario: 'The booking portal binds getBooking to GET /bookings/{bookingId} and, after a rebinding slip, getBookingHistory to GET /bookings/:id: the same route in the Express spelling, so a router can dispatch only one of them.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [{ id: 'booking_portal', componentType: 'Portal', transport: 'HTTP', basePath: '/v1', invokedBy: { kind: 'entry', caller: 'The patient web app and the clinic front desk, over HTTPS' }, description: 'The booking API.' }],
      interfaces: [{
        id: 'ibooking_api', component: 'booking_portal', methods: [
          { name: 'getBooking', description: 'Read one booking.', params: [{ name: 'bookingId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/bookings/{bookingId}' } },
          { name: 'getBookingHistory', description: 'Read a booking history.', params: [{ name: 'id', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/bookings/:id' } },
        ],
      }],
    },
  }),
  defineRuleFixture({
    code: 'ENDPOINT_ROUTE_DUPLICATE',
    severity: 'error',
    anchoredTo: 'islot_api',
    expectFire: true,
    scenario: 'Two Portals of the clinic both mount under basePath /api and both bind GET /slots/{slotId}: behind the one /api prefix they share, the route is bound twice.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'slot_portal', componentType: 'Portal', transport: 'HTTP', basePath: '/api', invokedBy: { kind: 'entry', caller: 'The patient web app and the clinic front desk, over HTTPS' }, description: 'The slot API.' },
        { id: 'admin_portal', componentType: 'Portal', transport: 'HTTP', basePath: '/api/', invokedBy: { kind: 'entry', caller: 'Clinic administrators in the back-office console, over HTTPS' }, description: 'The admin API.' },
      ],
      interfaces: [
        { id: 'islot_api', component: 'slot_portal', methods: [{ name: 'getSlot', description: 'Read one slot.', params: [{ name: 'slotId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/slots/{slotId}' } }] },
        { id: 'iadmin_api', component: 'admin_portal', methods: [{ name: 'inspectSlot', description: 'Inspect one slot.', params: [{ name: 'slotId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/slots/{slotId}' } }] },
      ],
    },
  }),
  defineRuleFixture({
    code: 'ENDPOINT_ROUTE_DUPLICATE',
    expectFire: false,
    reason: 'Each route binds one verb: the same path under two verbs, and the same path in two Portals that declare no shared basePath (two services), are distinct routes.',
    scenario: 'The booking portal binds GET and DELETE /bookings/{bookingId}; a separate billing portal with no basePath also binds GET /bookings/{bookingId} on its own service.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'booking_portal', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'The patient web app and the clinic front desk, over HTTPS' }, description: 'The booking API.' },
        { id: 'billing_portal', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'The insurers billing system, over HTTPS on its own host' }, description: 'The billing API.' },
      ],
      interfaces: [
        { id: 'ibooking_api', component: 'booking_portal', methods: [
          { name: 'getBooking', description: 'Read one booking.', params: [{ name: 'bookingId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/bookings/{bookingId}' } },
          { name: 'cancelBooking', description: 'Cancel one booking.', params: [{ name: 'bookingId', type: 'string' }], returns: 'void', endpoint: { transport: 'HTTP', method: 'DELETE', path: '/bookings/{bookingId}' } },
        ] },
        { id: 'ibilling_api', component: 'billing_portal', methods: [{ name: 'billBooking', description: 'Read the bill of one booking.', params: [{ name: 'bookingId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/bookings/{bookingId}' } }] },
      ],
    },
  }),
  // -------------------------------------------------------------------------
  // ENDPOINT_STATUS_MISMATCH
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ENDPOINT_STATUS_MISMATCH',
    severity: 'warning',
    anchoredTo: 'ibooking_api',
    expectFire: true,
    scenario: 'The booking portal states 299 for its booking read: a code no client library names.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [{ id: 'booking_portal', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'The patient web app and the clinic front desk, over HTTPS' }, description: 'The booking API.' }],
      interfaces: [{
        id: 'ibooking_api', component: 'booking_portal', methods: [
          { name: 'getBooking', description: 'Read one booking.', params: [{ name: 'bookingId', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/bookings/{bookingId}', status: 299 } },
        ],
      }],
    },
  }),
  defineRuleFixture({
    code: 'ENDPOINT_STATUS_MISMATCH',
    severity: 'warning',
    anchoredTo: 'ibooking_api',
    expectFire: true,
    scenario: 'The booking portal answers its booking summary under a 302 redirect: the response is a Location header and no body, so the summary record it answers is dropped.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [{ id: 'booking_portal', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'The patient web app and the clinic front desk, over HTTPS' }, description: 'The booking API.' }],
      interfaces: [{
        id: 'ibooking_api', component: 'booking_portal', methods: [
          { name: 'getSummary', description: 'Read one booking summary.', params: [{ name: 'bookingId', type: 'string' }], returns: 'booking_summary', endpoint: { transport: 'HTTP', method: 'GET', path: '/bookings/{bookingId}/summary', status: 302 } },
        ],
      }],
      types: [{ id: 'booking_summary', kind: 'value-object', subsystem: 'scheduling', name: 'BookingSummary', description: 'A booking at a glance.', fields: [{ name: 'slot', type: 'string' }] }],
    },
  }),
  defineRuleFixture({
    code: 'ENDPOINT_STATUS_MISMATCH',
    expectFire: false,
    reason: 'A redirect whose method answers the location (a string) and a 202 for a method answering nothing both agree with what the response carries.',
    scenario: 'The booking portal redirects GET /b/{code} to the booking page (the method answers the page URL) and accepts a reminder request with 202.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [{ id: 'booking_portal', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'The patient web app and the clinic front desk, over HTTPS' }, description: 'The booking API.' }],
      interfaces: [{
        id: 'ibooking_api', component: 'booking_portal', methods: [
          { name: 'openBookingLink', description: 'Send the caller on to the booking page.', params: [{ name: 'code', type: 'string' }], returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/b/{code}', status: 302 } },
          { name: 'queueReminder', description: 'Queue a reminder.', params: [{ name: 'bookingId', type: 'string' }], returns: 'async void', endpoint: { transport: 'HTTP', method: 'POST', path: '/bookings/{bookingId}/reminders', status: 202 } },
        ],
      }],
    },
  }),
];
