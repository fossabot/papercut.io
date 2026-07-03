# Apple Distribution Runbook

This file records what Papercut still needs before macOS releases stop showing Gatekeeper warnings and before CI can produce an iOS App Store build.

## Current Branch Audit

- Branch: `feature/macos-build`.
- Desktop CI already builds Linux, Windows, macOS Intel, and macOS Apple Silicon in `.github/workflows/ci.yml` and `.github/workflows/release.yml`.
- macOS release output now has CI plumbing for signing/notarization, but it still needs one GitHub release/workflow run to prove the `.dmg` is signed, notarized, and stapled.
- README, TTS docs, and site install notes now distinguish official signed/notarized releases from unsigned local/PR development artifacts.
- `src-tauri/tauri.macos.conf.json` stages native TTS dylibs and enables hardened runtime with `src-tauri/Entitlements.plist`.
- App bundle includes native dylibs in `Contents/Resources`: `libsherpa-onnx-c-api.dylib`, `libonnxruntime.dylib`, optionally `libsherpa-onnx-cxx-api.dylib`. Signing must cover these too.
- Android CI currently creates a debug APK. That is unrelated to Apple work, but it is not a production Android release signing path.
- No `src-tauri/gen/apple` or iOS Xcode project is committed yet.
- No certificate, key, provisioning profile, `.p12`, `.p8`, `.cer`, `.csr`, or keystore files are committed.
- Working tree had unrelated user changes when this audit was written. Do not mix Apple distribution work with those changes.

## Sources

- Apple Developer ID certificates: https://developer.apple.com/help/account/certificates/create-developer-id-certificates/
- Apple CSR instructions: https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/
- Apple Developer ID / Gatekeeper / notarization overview: https://developer.apple.com/developer-id/
- App Store Connect API keys: https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/
- Tauri macOS signing: https://v2.tauri.app/distribute/sign/macos/
- Tauri iOS signing: https://v2.tauri.app/distribute/sign/ios/
- Tauri App Store distribution: https://v2.tauri.app/distribute/app-store/

## Best Path

Use GitHub Releases for Linux, Windows, Android, and macOS. Use Apple App Store / TestFlight for iOS.

For macOS outside App Store, use:

1. Developer ID Application certificate.
2. Hardened runtime and correct entitlements.
3. Tauri/codesign signing on both macOS CI jobs.
4. Apple notarization.
5. Stapled notarization ticket on `.app` / `.dmg`.

For iOS, use:

1. Tauri iOS project committed under `src-tauri/gen/apple`.
2. App Store Connect app record.
3. Apple Distribution certificate.
4. App Store Connect provisioning profile, or Xcode automatic signing via App Store Connect API.
5. GitHub Actions macOS runner to build `.ipa`.
6. Upload to TestFlight/App Store with App Store Connect API key.

## macOS: Apple Work Before Repo Changes

### 1. Confirm Apple account access

Need Apple Developer Program membership active.

Need Account Holder role for Developer ID certificate creation. Apple allows up to five Developer ID Application certificates and five Developer ID Installer certificates.

### 2. Decide certificate type

Choose `Developer ID Application`.

Choose `G2 Sub-CA (Xcode 11.4.1 or later)`.

Do not choose `Previous Sub-CA` unless you must support ancient Xcode/macOS signing flows. Not needed for this project.

Developer ID Installer certificate is optional. Papercut ships `.dmg`, not signed `.pkg`, so start with Developer ID Application only.

### 3. Generate CSR without owning a Mac

Apple docs describe Keychain Access on Mac, but CSR is a standard certificate signing request. You can generate it with OpenSSL on Linux. Protect the private key; the downloaded Apple `.cer` is useless without it.

If Apple rejects this CSR for any reason, use a one-time GitHub Actions macOS workflow or a borrowed/trusted Mac to generate the CSR and immediately export the resulting `.p12`. Routine release builds can still happen on GitHub-hosted macOS runners; you do not need to own a Mac for every release.

Run outside repo, for example in a private temp folder:

```bash
mkdir -p ~/private-apple-signing/papercut-macos
cd ~/private-apple-signing/papercut-macos

openssl genrsa -out developer-id-application.key 2048

openssl req -new \
  -key developer-id-application.key \
  -out developer-id-application.certSigningRequest \
  -subj "/emailAddress=YOUR_APPLE_ID_EMAIL/CN=Papercut Developer ID Application/C=CA"
```

Upload `developer-id-application.certSigningRequest` in Apple Developer `Certificates, Identifiers & Profiles`.

Download Apple result, usually `developerID_application.cer`.

Convert and export a CI-ready `.p12`:

```bash
openssl x509 -inform DER \
  -in developerID_application.cer \
  -out developer-id-application.pem

openssl pkcs12 -export \
  -inkey developer-id-application.key \
  -in developer-id-application.pem \
  -out papercut-developer-id-application.p12 \
  -name "Developer ID Application: YOUR_NAME_OR_ORG (TEAMID)" \
  -keypbe PBE-SHA1-3DES \
  -certpbe PBE-SHA1-3DES \
  -macalg sha1
```

Use a strong unique export password. Store it in password manager.

Keep these offline:

- `developer-id-application.key`
- `papercut-developer-id-application.p12`
- `.p12` password

Do not commit them. Do not upload them as workflow artifacts.

### 4. Create App Store Connect API key for notarization

Prefer App Store Connect API key over Apple ID/app-specific password.

In App Store Connect:

1. Open `Users and Access`.
2. Open `Integrations`.
3. If needed, Account Holder requests API access.
4. Create a Team API key.
5. For macOS notarization, `Developer` access is normally enough.
6. Save `Issuer ID`.
7. Save `Key ID`.
8. Download the `.p8` private key once.

Store `.p8` in password manager. If lost or leaked, revoke and recreate it.

### 5. Create GitHub secrets for macOS

Recommended GitHub Environment: `apple-release`.

Protect it with required reviewer approval and restrict release workflow branches/tags.

The release workflow now has a separate `build-macos` job with `environment: apple-release`, so the macOS jobs can read environment secrets while Linux, Windows, and Android jobs cannot. Keep the environment protected with required reviewers and deployment branch/tag restrictions.

Secrets:

- `APPLE_DEVELOPER_ID_CERTIFICATE_BASE64`: base64 of `papercut-developer-id-application.p12`
- `APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD`: `.p12` export password
- `APPLE_SIGNING_IDENTITY`: exact identity, e.g. `Developer ID Application: Name (TEAMID)`. The release workflow now detects this from the imported certificate and exports it for Tauri, so this secret is mainly useful as a human reference.
- `APPLE_TEAM_ID`: Apple Team ID
- `APPLE_API_ISSUER`: App Store Connect Issuer ID
- `APPLE_API_KEY`: App Store Connect Key ID for Tauri notarization
- `APPLE_API_PRIVATE_KEY_BASE64`: base64 of `AuthKey_KEYID.p8`
- `APPLE_KEYCHAIN_PASSWORD`: random CI-only temporary keychain password

Create base64 values:

```bash
base64 -w 0 papercut-developer-id-application.p12 > developer-id.p12.base64
base64 -w 0 AuthKey_KEYID.p8 > authkey.p8.base64
```

macOS BSD base64 uses:

```bash
base64 -i papercut-developer-id-application.p12 | tr -d '\n' > developer-id.p12.base64
base64 -i AuthKey_KEYID.p8 | tr -d '\n' > authkey.p8.base64
```

Before rerunning a release, verify the `.p12` password locally with the exact password stored in `APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD`:

```bash
openssl pkcs12 \
  -in papercut-developer-id-application.p12 \
  -info \
  -noout \
  -passin pass:'YOUR_P12_EXPORT_PASSWORD'
```

If this prints `MAC verification failed`, the password is not the `.p12` export password for that file. Re-export the `.p12` or update the GitHub secret.

If OpenSSL verification passes but macOS `security import` fails with `MAC verification failed during PKCS12 import`, the `.p12` is probably using OpenSSL 3's modern PBES2/AES encryption, which OpenSSL can read but macOS Keychain import may reject. Re-export with the `PBE-SHA1-3DES` / `sha1` compatibility flags shown above, then regenerate `APPLE_DEVELOPER_ID_CERTIFICATE_BASE64`. The release workflow also converts the decoded `.p12` into this Keychain-compatible form before import.

If local verification passes but CI still fails before `security import`, regenerate `APPLE_DEVELOPER_ID_CERTIFICATE_BASE64` from the same verified `.p12` and paste it into GitHub again without quotes or extra spaces.

## macOS: Repo Work After Apple Work

Do this only after secrets exist. These repo changes are now started in this branch.

### 1. Add macOS entitlements

Added `src-tauri/Entitlements.plist`.

Likely needed for Tauri/WKWebView hardened runtime:

- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`

Keep entitlements minimal. Add more only if notarization or runtime testing proves need.

### 2. Add macOS bundle config

Updated `src-tauri/tauri.macos.conf.json` with:

- `bundle.macOS.signingIdentity` or use `APPLE_SIGNING_IDENTITY`.
- `bundle.macOS.entitlements`.
- `bundle.macOS.hardenedRuntime: true` if Tauri version/config supports it.
- `bundle.macOS.minimumSystemVersion` if needed.

### 3. Update release workflow

Release workflow now does this in the protected `build-macos` job for each macOS architecture:

1. Decode `.p12`.
2. Create temporary keychain.
3. Import certificate.
4. Add the temporary keychain to the user keychain search list.
5. Allow `/usr/bin/codesign` access.
6. Detect the imported `Developer ID Application` identity and export it as `APPLE_SIGNING_IDENTITY`.
7. Decode `.p8` into `$RUNNER_TEMP/private_keys/AuthKey_KEYID.p8` and export the absolute path as `APPLE_API_KEY_PATH`.
8. Export Tauri notarization env vars.
9. Run `npm run desktop`.
10. Verify signatures.
11. Verify notarization/stapling.
12. Upload signed/notarized `.dmg`.

Verification commands on macOS runner:

```bash
codesign --verify --deep --strict --verbose=2 "src-tauri/target/release/bundle/macos/Papercut.app"
spctl --assess --type execute --verbose=4 "src-tauri/target/release/bundle/macos/Papercut.app"
spctl --assess --type open --context context:primary-signature --verbose=4 src-tauri/target/release/bundle/dmg/*.dmg
```

### 4. Keep public install docs current

README, `docs/kokoro-tts.md`, and `site/index.html` now describe signed/notarized release DMGs and reserve right-click Open guidance for unsigned development artifacts. After the first signed release succeeds, update any version-specific download filenames/sizes on the site.

## iOS: Apple Work Before Repo Changes

### 1. Decide final iOS Bundle ID

Current Tauri identifier is:

```text
io.papercut.desktop
```

This can work if Apple accepts it, but name is awkward for iOS. Decide before creating App ID/App Store record.

Options:

- Keep `io.papercut.desktop` for fastest path.
- Use cleaner ID like `app.trypapercut.papercut`, but this may require Tauri config work and may affect desktop app identity if not isolated.

Best path: keep desktop identifier stable, then add iOS-specific config only if Tauri supports clean platform override in current version. Otherwise use current identifier for first iOS build.

### 2. Create App Store Connect app record

In App Store Connect:

1. Apps > add new app.
2. Platform: iOS.
3. Name: `Papercut`.
4. Bundle ID: chosen Bundle ID.
5. SKU: stable internal value, e.g. `papercut-ios`.
6. User Access: as needed.

### 3. Register App ID and capabilities

In Apple Developer:

1. Identifiers > App IDs > new app.
2. Bundle ID exactly matches Tauri identifier.
3. Enable only capabilities needed.
4. For iOS background audiobook playback, enable Background Modes in Xcode project later and include audio mode.

Do not enable CloudKit, Push, Sign in with Apple, App Groups, etc. unless product needs them.

### 4. Choose signing mode

Best first CI path: manual signing.

Manual signing is more work upfront but deterministic in CI:

- Apple Distribution certificate as `.p12`.
- App Store Connect provisioning profile as `.mobileprovision`.
- App Store Connect API key for upload.

Automatic signing can work with App Store Connect API key, but failures are harder to debug on fresh runners.

### 5. Create Apple Distribution certificate

Create CSR same way as macOS, outside repo:

```bash
mkdir -p ~/private-apple-signing/papercut-ios
cd ~/private-apple-signing/papercut-ios

openssl genrsa -out apple-distribution.key 2048

openssl req -new \
  -key apple-distribution.key \
  -out apple-distribution.certSigningRequest \
  -subj "/emailAddress=YOUR_APPLE_ID_EMAIL/CN=Papercut Apple Distribution/C=CA"
```

In Apple Developer Certificates, create `Apple Distribution` certificate with that CSR.

Download `.cer`, convert/export `.p12`:

```bash
openssl x509 -inform DER \
  -in distribution.cer \
  -out apple-distribution.pem

openssl pkcs12 -export \
  -inkey apple-distribution.key \
  -in apple-distribution.pem \
  -out papercut-apple-distribution.p12 \
  -name "Apple Distribution: YOUR_NAME_OR_ORG (TEAMID)"
```

### 6. Create App Store Connect provisioning profile

In Apple Developer:

1. Profiles > add.
2. Distribution type: `App Store Connect`.
3. Select the Papercut App ID.
4. Select Apple Distribution certificate.
5. Name it `Papercut iOS App Store`.
6. Download `.mobileprovision`.

### 7. Create App Store Connect API key for upload

You can reuse the same `.p8` key if role is enough, but cleaner path is separate key:

- `Papercut CI Upload`
- Access: `Developer` if upload works; `Admin` if using automatic signing or if Apple tooling requires it.

Save:

- Issuer ID
- Key ID
- `.p8` private key

### 8. Create GitHub secrets for iOS

In protected `apple-release` environment:

- `IOS_CERTIFICATE`: base64 of `papercut-apple-distribution.p12`
- `IOS_CERTIFICATE_PASSWORD`: `.p12` password
- `IOS_MOBILE_PROVISION`: base64 of `.mobileprovision`
- `APPLE_API_ISSUER`: App Store Connect Issuer ID
- `APPLE_API_KEY_ID`: App Store Connect Key ID for `altool`
- `APPLE_API_KEY`: same key ID if Tauri expects this variable
- `APPLE_API_PRIVATE_KEY_BASE64`: base64 of `AuthKey_KEYID.p8`
- `APPLE_TEAM_ID`: Team ID
- `APPLE_KEYCHAIN_PASSWORD`: random CI-only temporary keychain password

## iOS: Repo Work After Apple Work

### 1. Initialize Tauri iOS project

Needs macOS runner or Mac environment:

```bash
npm ci
npm run tauri -- ios init
```

Commit generated `src-tauri/gen/apple` files that Tauri expects in source control.

### 2. Configure iOS app capabilities

Open/check generated Xcode project.

Required likely:

- Bundle identifier matches App Store Connect.
- Development Team set to Apple Team ID.
- Background Modes > Audio enabled if mobile audiobook playback must continue while locked/backgrounded.
- App icons complete.
- `Info.plist` includes encryption export setting if needed.

Because Papercut uses `reqwest`/TLS for model downloads, export compliance must be answered carefully in App Store Connect. If only standard HTTPS/TLS and no custom crypto, usually mark non-exempt encryption as false or answer Apple's standard encryption questions accordingly. Confirm before submission.

### 3. Add iOS build script

Add npm script, likely:

```json
"ios:ipa": "tauri ios build --export-method app-store-connect --features native-tts-shared"
```

Native TTS on iOS still needs separate validation. The docs mention frontend recognizes iOS and native audio plugin uses AVPlayer, but this repo currently documents supported native TTS/import builds as desktop and Android. Expect iOS native TTS/library issues until proven on a real device/TestFlight.

### 4. Add CI job

New release job on `macos-15`:

1. Checkout.
2. Setup Node/Rust.
3. Install Rust iOS target if needed.
4. `npm ci`.
5. Decode API key into `private_keys/AuthKey_KEYID.p8`.
6. Import Apple Distribution `.p12` into temporary keychain.
7. Install provisioning profile.
8. Run `npm run tauri -- ios build --export-method app-store-connect`.
9. Upload `.ipa` as artifact.
10. Upload `.ipa` to App Store Connect/TestFlight with `xcrun altool` or newer Apple upload tool.

Expected output per Tauri docs:

```text
src-tauri/gen/apple/build/arm64/Papercut.ipa
```

### 5. TestFlight gate

First CI success only means Apple accepted upload. Still need:

- TestFlight processing pass.
- Export compliance completed.
- App privacy labels completed.
- Internal tester smoke test.
- External beta review if using external testers.
- Full App Review for production release.

## Secret Security Rules

1. Never commit `.key`, `.p12`, `.p8`, `.mobileprovision`, `.provisionprofile`, `.cer`, `.certSigningRequest`, or generated `private_keys/`.
2. Treat `.csr` as non-secret but still keep it out of repo to avoid confusion.
3. Store original private keys and `.p12` files in a password manager or encrypted offline vault.
4. Use separate certificates for Developer ID Application and Apple Distribution.
5. Use separate App Store Connect API keys for notarization and iOS upload if you want clean rotation.
6. Use GitHub Environments with required approvals for Apple release jobs.
7. Restrict release workflow trigger and environment deployment rules to protected tags like `v*.*.*`. Be careful with `workflow_dispatch`: the input ref is checked out and its build scripts run with signing secrets, so only approve runs for trusted protected tags.
8. Do not print secrets or decoded file contents in CI logs.
9. Create temporary keychains in CI and delete them at job end.
10. Rotate/revoke immediately if a `.p12`, private key, `.p8`, or GitHub secret leaks.
11. Keep certificate passwords unique and unrelated to Apple ID password.
12. Prefer App Store Connect API keys over Apple ID app-specific passwords.
13. Use absolute paths for decoded CI secret files because Tauri/notarytool may run from `src-tauri` instead of the repository root.

## Critical Risks

- No macOS notarization means users get Gatekeeper warnings. Signing alone is not enough for modern macOS distribution.
- Missing hardened runtime or wrong entitlements can make notarization fail or app launch fail after signing.
- Native dylibs in Resources must be signed/notarized as part of bundle.
- No iOS project exists yet; CI cannot build iOS until `tauri ios init` output is committed.
- iOS native TTS is not proven in this branch. Build may work before runtime audio/model download path is App Store ready.
- Current App ID `io.papercut.desktop` may be accepted but is a poor long-term iOS identifier.
- Apple private keys are high-value secrets. Losing the private key used for CSR means the downloaded certificate cannot be used.

## Done Definition

macOS done:

- CI imports Developer ID cert from secrets.
- CI builds signed DMG for Intel and Apple Silicon.
- CI notarizes and staples.
- `codesign` and `spctl` checks pass on runner.
- README no longer tells users to bypass unsigned-app warning.

iOS done:

- `src-tauri/gen/apple` committed.
- App Store Connect app record exists.
- CI builds signed `.ipa`.
- CI uploads `.ipa` to App Store Connect.
- Build appears in TestFlight.
- Internal tester installs and launches on real iPhone/iPad.
