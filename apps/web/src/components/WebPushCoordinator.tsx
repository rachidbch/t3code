import { WebPushReconciler } from "../hooks/useWebPush";
import { useEnvironmentIds } from "../state/environments";

export function WebPushCoordinator() {
  return useEnvironmentIds().map((environmentId) => (
    <WebPushReconciler key={environmentId} environmentId={environmentId} />
  ));
}
