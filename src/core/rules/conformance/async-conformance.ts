import { defaultConformanceTier, parseTypeExpression, pathKey } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';
import { declaredReading, signatureMethods } from '../read-model.js';

// ---------------------------------------------------------------------------
// Code↔spec for ASYNC: does the function realizing a contract method complete
// when the contract says it does?
//
// `async T` on a returns is the contract saying the call completes later.
// Every caller in every language with async/await is shaped by the
// difference, so a contract that hides it misleads every implementer and
// every translation built from it — and a marker no check reads drifts: the
// tree this rule was written for marked 58 of its 120 async methods.
//
// Read the way param-conformance reads a signature: the bodies under the
// method's `symbol` in its own file, at exact grade only, and where a name has
// several bodies (a class member and the facade forwarding to it) only what
// they ALL say is reported. A body completes later when it is declared
// `async` or annotated to return a Promise (source_file_facts.asyncFunctions,
// one entry per such body). A file that only CALLS the function holds no body
// and is methodRealization's finding, never a second voice here.
//
// An ABSTRACTION's method has no body: it is read where a body would be, from
// the signature its declaring interface, trait, Protocol or abstract class states for the
// member (member_signature_fact.completesLater, one per overload), and
// reported with the same code. Where the grade cannot read member signatures
// nothing is compared.
//
// CARRYABLE: it measures this project's own code against its own spec at a
// site the finding names, the contract method; paying it means changing one
// side — usually the spec, whose returns gains `async`.
// ---------------------------------------------------------------------------

export const asyncConformanceRule: SddRule = {
  name: 'async-conformance',
  judges: 'code',
  description: "Code-to-contract for ASYNC: a contract method whose returns is `async T` is realized by a function that completes later, and one whose returns is not, by one that completes now — every caller in every language with async/await is shaped by the difference, so a contract that hides it misleads every implementer and translation built from it. Compared with source_file_facts.asyncFunctions for the method's realizing function (under its `symbol`), at exact grade only; where a name has several bodies only what they all agree on is reported, as param-conformance does. An abstraction's method is compared with its declaration, never a body: whether the signature its declaring interface, trait, Protocol or abstract class states for the member completes later (member_signature_fact.completesLater, per overload, read at exact grade and by the Python reader for a Protocol or an abstract base class), whatever constructor, helpers or default bodies the class also holds, reported with the same ASYNC_MISMATCH; where the grade cannot read member signatures nothing is compared, and param-conformance's ABSTRACTION_DECLARATION_UNCOMPARED says so. A method whose file only calls the function is methodRealization's finding, and a method whose conformance dial is off (its own, else its implementation's) is not judged.",
  codes: [
    {
      code: 'ASYNC_MISMATCH',
      defaultSeverity: 'warning',
      summary: 'A contract method and the function realizing it disagree about whether the call completes later: the returns says `async T` and the code completes now, or the code is async and the returns does not say so',
      carryable: true,
    },
  ],

  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();

    for (const { implementation, method, component, sourceFile, draftContext } of signatureMethods(ctx)) {
      // ---- 0. the conformance dial: off is no realization check at all ----
      if ((method.conformance ?? implementation.conformance ?? defaultConformanceTier(component)) === 'off') continue;
      // ---- 1. gather: the contract method, and the bodies realizing it ----
      const contractMethod = ctx.interfaceMap.get(implementation.contract)?.methods.find((m) => m.name === method.name);
      if (!contractMethod || typeof contractMethod.returns !== 'string' || !sourceFile) continue;
      const file = pathKey(sourceFile);
      const facts = code.factsAt(file);

      // ---- 2 / 6. silent unless a body is there to read ----
      // The bodies are the signatures the analyzer recorded under the name,
      // one per body; a name with none has no body in this file.
      // A body is read at exact grade only; an abstraction's declaration is read wherever a reader
      // recorded member signatures (exact grade, or the Python reader for a Protocol).
      if (!facts || facts.status !== 'analyzed' || !(facts.analysisGrade === 'exact' || component?.abstract === true)) continue;
      const symbol = method.symbol ?? method.name;
      // The bodies, or — for an abstraction, which has none — the signatures its declaration states.
      let bodies: number;
      let asyncBodies: number;
      if (component?.abstract === true) {
        const declaration = declaredReading(facts, symbol, component);
        if (!declaration) continue;
        bodies = declaration.params.length;
        asyncBodies = declaration.completing;
      } else {
        const signatures = facts.functionParams;
        if (!signatures || !Object.prototype.hasOwnProperty.call(signatures, symbol)) continue;
        bodies = signatures[symbol].length;
        if (bodies === 0) continue;
        asyncBodies = (facts.asyncFunctions ?? []).filter((name) => name === symbol).length;
      }

      // ---- 3. read both sides ----
      // The contract's returns is canonical once loaded; one that does not
      // read cleanly is type-expressions' finding, and says nothing here.
      const returns = parseTypeExpression(contractMethod.returns, 'returns');
      if (!returns.expression) continue;
      const contractAsync = returns.expression.form === 'async';

      // ---- 4. report only what every body agrees on ----
      const subject = bodies > 1
        ? `every function called "${symbol}" in "${file}"`
        : `the function "${symbol}" in "${file}"`;
      if (contractAsync && asyncBodies === 0) {
        ctx.addIssue(
          'warning',
          'ASYNC_MISMATCH',
          `Method "${method.name}" of contract "${implementation.contract}" returns "${contractMethod.returns}", which `
          + `completes later, but ${subject} completes now — it is neither declared async nor annotated to return a `
          + 'Promise. Every caller is told to await a call that answers at once. Make the code async, or drop `async` '
          + 'from the returns.',
          implementation.id,
          draftContext,
          undefined,
          { at: method.name },
        );
      } else if (!contractAsync && asyncBodies === bodies) {
        ctx.addIssue(
          'warning',
          'ASYNC_MISMATCH',
          `Method "${method.name}" of contract "${implementation.contract}" returns "${contractMethod.returns}", which `
          + `completes now, but ${subject} completes later (declared async, or annotated to return a Promise). Every `
          + 'caller built from the contract forgets to await it. Write the returns as '
          + `"async ${contractMethod.returns}" — or, if the code is async by accident, make it complete now.`,
          implementation.id,
          draftContext,
          undefined,
          { at: method.name },
        );
      }
      // ---- 5. judged ----
    }
  },
};
