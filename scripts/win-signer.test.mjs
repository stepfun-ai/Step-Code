// signtool's `verify /v` report is parsed to name the certificate that actually
// signed a Windows file. The release must fail on any other signer, so the
// parser has to pick the leaf of the signing chain, not its root or the
// timestamp chain that follows it.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { signerThumbprint } = require("../apps/desktop/scripts/win-signer.cjs");

const EV = "1EBC77B8FE31D069FE8015C75B8FFC714120E9C9";

// Shape of `signtool verify /pa /all /v` for an EV-signed, timestamped file. The
// console code page drops the Chinese subject, which is why the thumbprint and
// not "Issued to" identifies the signer.
const report = `
Verifying: dist-electron\\StepCode-0.1.0-win-x64.exe

Signature Index: 0 (Primary Signature)
Hash of file (sha256): 4F2C0D0E5B1A

Signing Certificate Chain:
    Issued to: GlobalSign Root CA
    Issued by: GlobalSign Root CA
    Expires:   Fri Jan 28 20:00:00 2028
    SHA1 hash: B1BC968BD4F49D622AA89A81F2150152A41D829C

        Issued to: GlobalSign Extended Validation CodeSigning CA - SHA256 - G3
        Issued by: GlobalSign
        Expires:   Wed Mar 18 08:00:00 2026
        SHA1 hash: 8E9D9C5A8A3E4E1E7E9D8C7B6A5F4E3D2C1B0A99

            Issued to: ????????????
            Issued by: GlobalSign Extended Validation CodeSigning CA - SHA256 - G3
            Expires:   Thu Dec 31 15:38:56 2026
            SHA1 hash: ${EV.toLowerCase()}

The signature is timestamped: Thu Oct 29 17:36:16 2026
Timestamp Verified by:
    Issued to: GlobalSign Root CA - R6
    Issued by: GlobalSign Root CA - R6
    Expires:   Sun Dec 10 08:00:00 2034
    SHA1 hash: 8094640EB5A7A1CA119C1FDDD59F810263A7FBD1

        Issued to: Globalsign R45 TSA for CodeSign 202510
        Issued by: GlobalSign Offline R45 Timestamping CA 2025
        Expires:   Sat Jan 01 08:00:00 2037
        SHA1 hash: 0123456789ABCDEF0123456789ABCDEF01234567

Successfully verified: dist-electron\\StepCode-0.1.0-win-x64.exe
`;

test("the signer is the leaf of the signing chain, before the timestamp chain", () => {
	assert.equal(signerThumbprint(report), EV);
});

test("a report without a signing chain names no signer", () => {
	assert.equal(signerThumbprint("SignTool Error: No signature found."), undefined);
});

test("an untimestamped report still names its signer", () => {
	const untimestamped = report.slice(0, report.indexOf("The signature is timestamped"));
	assert.equal(signerThumbprint(untimestamped), EV);
});
