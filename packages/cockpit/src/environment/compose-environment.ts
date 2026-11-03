// Compose process environments are completed here after their owning boundary has rejected
// caller-supplied COMPOSE_* values. The fixed value prevents unauthenticated project .env bytes
// from changing an authenticated plan while leaving service env_file loading available at runtime.
export function composeProcessEnvironment(
    env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
    return Object.freeze({ ...env, COMPOSE_DISABLE_ENV_FILE: '1' })
}
