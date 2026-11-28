import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// A component's external link is rendered as a link a reader clicks — on the
// canvas, the dev page and a shared page — so its url must be an absolute
// https URL (http only for localhost or 127.0.0.1) and carry no credentials.
// Anything else (`javascript:`, `data:`, `file:`, a relative or malformed
// url) is refused, naming the component and the link.
// ---------------------------------------------------------------------------

const ACCEPTED = 'an absolute https URL without credentials (http only for localhost or 127.0.0.1)';

function shorten(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Why a url is unsafe to render as a link, or undefined when it is safe. */
function unsafeReason(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'it is not an absolute URL';
  }
  if (url.username || url.password) return 'it carries credentials (a user name or password)';
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return undefined;
  return `its scheme "${url.protocol.replace(/:$/, '')}" is not accepted`;
}

export const externalLinksRule: SddRule = {
  name: 'external-links',
  judges: 'design',
  description:
    "A component's external link is rendered as a link a reader clicks — on the canvas, the dev page and a shared page — so its url must be an absolute https URL (http only for localhost or 127.0.0.1); any other scheme (`javascript:`, `data:`, `file:`), a relative or malformed URL, or one carrying credentials is refused, naming the component and the link. The canvas never renders such a link as clickable either, so a tree written before this rule cannot be used against its viewers.",
  codes: [
    {
      code: 'EXTERNAL_LINK_UNSAFE',
      defaultSeverity: 'error',
      summary:
        "A component's external link is not an absolute https URL (http only for localhost), or carries credentials — it would be rendered as a clickable link",
    },
  ],
  check(ctx) {
    for (const component of ctx.components) {
      if (!ctx.isSpecInScope(component.id)) continue;
      for (const link of component.externalLinks ?? []) {
        const why = unsafeReason(link.url);
        if (!why) continue;
        const name = link.label ? `"${shorten(link.label)}"` : `"${shorten(link.url)}"`;
        ctx.addIssue(
          'error',
          'EXTERNAL_LINK_UNSAFE',
          `Component "${component.id}" has an external link ${name} that cannot be rendered as a link: ${why}. Use ${ACCEPTED}.`,
          component.id,
          ctx.isComponentDraft(component.id),
        );
      }
    }
  },
};
