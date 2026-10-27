import type { SecretRef } from './operability';

export type SecretResolution =
  | { status: 'RESOLVED'; bytes: Uint8Array }
  | { status: 'NOT_CONFIGURED' };

/** Synchronous offline port. A future runtime must provision a resolver explicitly. */
export interface SecretResolver {
  resolve(ref: SecretRef): SecretResolution;
}

export function isSecretRef(ref: unknown): ref is SecretRef {
  return !!ref && typeof ref === 'object' && !Array.isArray(ref) &&
    Object.keys(ref).length === 1 && Object.hasOwn(ref, 'id') &&
    typeof (ref as SecretRef).id === 'string' &&
    /^secret-ref-[a-zA-Z0-9-]{1,100}$/.test((ref as SecretRef).id) &&
    !/[^a-zA-Z0-9-]/.test((ref as SecretRef).id);
}

export class UnconfiguredSecretResolver implements SecretResolver {
  resolve(_ref: SecretRef): SecretResolution {
    return { status: 'NOT_CONFIGURED' };
  }
}

/** Test/simulator only. Private fields keep fixture bytes out of serialization. */
export class InMemorySyntheticSecretResolver implements SecretResolver {
  #values = new Map<string, Uint8Array>();

  constructor(entries: readonly { ref: SecretRef; syntheticValue: Uint8Array }[]) {
    for (const { ref, syntheticValue } of entries) {
      if (!isSecretRef(ref) || syntheticValue.byteLength === 0) {
        throw new Error('INVALID_SYNTHETIC_SECRET_CONFIGURATION');
      }
      this.#values.set(ref.id, new Uint8Array(syntheticValue));
    }
  }

  resolve(ref: SecretRef): SecretResolution {
    const bytes = isSecretRef(ref) ? this.#values.get(ref.id) : undefined;
    return bytes ? { status: 'RESOLVED', bytes: new Uint8Array(bytes) } : { status: 'NOT_CONFIGURED' };
  }
}

/** Errors and secret-manager details never cross the auth/audit boundary. */
export function resolveSecretBytes(resolver: SecretResolver, ref?: SecretRef): Uint8Array | undefined {
  if (!isSecretRef(ref)) return undefined;
  try {
    const result = resolver.resolve({ id: ref.id });
    return result.status === 'RESOLVED' && result.bytes instanceof Uint8Array && result.bytes.byteLength > 0
      ? new Uint8Array(result.bytes)
      : undefined;
  } catch {
    return undefined;
  }
}
