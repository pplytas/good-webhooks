# Use the Standard Webhooks protocol

Use the [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) for the default signing and verification contract. An established protocol lets receivers use independent implementations and avoids a custom header and signature convention. This decision does not select its npm package.

V0 implements the symmetric HMAC-SHA256 scheme with native cryptography. Verify interoperability against independently produced vectors and a reference implementation before release. Multiple custom signing protocols are outside v0.
