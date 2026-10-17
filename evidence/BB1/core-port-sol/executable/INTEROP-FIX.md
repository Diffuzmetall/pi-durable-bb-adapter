# Actual daemon ESM/CJS interop boot defect fixed (primary failure351)

Observed failure: integrator bb-parent-integrated-001 consumed main GO, server started but owned daemon failed before any parent/model. No replay or test-port restart by FoggyShore. Existing test executable restoration remains integrator-owned.

Exact reproduction under Node24.19: dynamic import of REAL host-daemon/dist/native-registration-support.mjs fails at line11 with Dynamic require of child_process is not supported. Stack identifies bundled cross-spawn@7.0.6 CJS var cp=__require("child_process") at line511. esbuild's ESM emission defines __require fallback but ESM has no lexical require. prepare-overlay.mjs used format=esm without the normal Node createRequire banner present in BB build-utils. This is moduleinterop at our owning support-build boundary, not missing Node builtins, Pi host/runtime, auth or provider schema.

Fix: support module compiler now emits module-local `import {createRequire as __nativeCreateRequire} from "node:module"; const require=__nativeCreateRequire(import.meta.url);`. No global shim, new launcher, dependency install, main bundle refactor or Pi Core changes. Source dispatcher/callback/consumer unchanged. Both existing generated support sources recompiled with same private esbuild0.25.12 plus banner; old modules retained as .before-interop. Actual server+daemon main bundles unchanged.

Retained regression candidates/parallel-bb-core/executable/interop-regression.mjs imports the REAL deployed support module and a private byte-for-byte actual patched daemon bundle copy with test-only factory export appended. It initializes the actual minified BB runtime module initializer SS and actual factory M0, asserts no providers running, and shuts down the real runtime. Main argv guard prevents daemon startup on import; zero ports/model/provider processes. It requires private HOME; XDG cache/TMPDIR also private. No fake auth/context/repository and no synthetic runtime factory. Red log reproduces exact original import failure; final green-private.log exits0 with realSupportImport PASS, actualBundledRuntimeFactory PASS, shutdown PASS, providersStarted0/mainBoots0/portsTouched0. Earlier green log retained before adding explicit private-HOME assertion. No broad Core suite comfort rerun.

Exact final regression command:

```
HOME=/home/ubuntu/Projects/pi-durable-bb-adapter/.pi/fixtures/core-sol/executable/interop-home XDG_CACHE_HOME=/home/ubuntu/Projects/pi-durable-bb-adapter/.pi/fixtures/core-sol/executable/interop-cache TMPDIR=/home/ubuntu/Projects/pi-durable-bb-adapter/.pi/fixtures/core-sol/executable/interop-tmp /home/ubuntu/.nvm/versions/node/v24.19.0/bin/node candidates/parallel-bb-core/executable/interop-regression.mjs
```

Updated deployable package root unchanged: .pi/fixtures/core-sol/executable/node_modules/bb-app. Corrected helper pins:
- server/dist/native-registration-support.mjs a1fe8337cc393bfbf66b242ebfb3e9cbc636a6f681b7a615fce4d2d4b58be7ba
- host-daemon/dist/native-registration-support.mjs bc770993bce76018fd215eafb2ca43b5a9cb6af73739e80eab208e4269795919
- prepare-overlay.mjs 9e978b3f426ceadb400a1e45c4004de3cec87be22f4165906fd910c1be42db79
- rebuild-support-interop.mjs fdd160f7343c24e6e356220b5160e1daca4057094d1179a63252ef037069aaa4
- interop-regression.mjs e9412d0fe5c7520ec8432525721aa7a5be179cdc294371125c1aa310f97dae93
- launch-manifest-interop-v2.json 862fecaaf9cc05f8ca3ed1630d854578fb03702d850afbd9b8d481bbe70e3921

Original launch/output manifests and all failed evidence retained; v2 supersedes old helper pins, never reuse consumed main GO. Rebuild-support script refuses unexpected pre-fix artifact hashes or existing backups; no silent repeated build/history overwrite.

Handoff to GreenIvy: use SAME owned copied public launchers and corrected package tree; bind fresh combined candidate/main GO to v2 manifest. GreenIvy alone mutates .test-bb40886/40887 and restarts test processes. Actual main daemon/server boot and complete parent→one child→real BB history view remain E2E gates; passing import/runtime-factory regression is not full primary success. FoggyShore has not restarted ports or run another main attempt.
