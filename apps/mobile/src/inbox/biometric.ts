import * as LocalAuthentication from "expo-local-authentication";

/**
 * Face ID (or Touch ID) for a destructive approval. Biometrics only: no passcode fallback, because
 * the host takes `confirmed: "biometric"` as proof the person was recognised on this device. A phone
 * with no enrolled biometrics cannot approve a destructive call; it can still deny, or approve at the Mac.
 */
export async function confirmWithBiometrics(reason: string): Promise<boolean> {
  if (!(await LocalAuthentication.hasHardwareAsync()) || !(await LocalAuthentication.isEnrolledAsync())) return false;
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    cancelLabel: "Cancel",
    disableDeviceFallback: true,
  });
  return result.success;
}
