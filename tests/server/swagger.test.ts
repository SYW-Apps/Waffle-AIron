import { describe, it, expect } from 'vitest';
import { swaggerUiPage, swaggerUiAvailable } from '../../src/server/swagger.js';

describe('Swagger UI viewer (sdd_host)', () => {
  it('inlines the spec + Swagger UI assets into a self-contained page', () => {
    expect(swaggerUiAvailable()).toBe(true); // swagger-ui-dist resolvable
    const page = swaggerUiPage('{"openapi":"3.1.0","info":{"title":"Demo API"}}', 'Demo API');
    expect(page).toContain('SwaggerUIBundle'); // the bundle JS is inlined (no external src)
    expect(page).toContain("layout:'BaseLayout'");
    expect(page).toContain('"openapi":"3.1.0"'); // the spec is embedded, not fetched
    expect(page).not.toMatch(/src\s*=\s*["']https?:/); // nothing loaded from an external host
  });

  it('escapes a </script> in the spec so the inline init cannot be broken out of', () => {
    const page = swaggerUiPage('{"x":"</script><script>alert(1)</script>"}');
    expect(page).not.toContain('</script><script>alert(1)');
    expect(page).toContain('<\\/script');
  });
});
