// path: nerdlets/home/hooks.js

import { useCallback, useEffect, useRef } from 'react';

/**
 * Returns a wrapper that drops state updates once the component has unmounted.
 *
 * Each module now unmounts when the user leaves it, which the single-component version
 * never did. A migration loop can be several minutes of sequential API calls, so the user
 * can easily hit "Back to Home" while one is still running. Aborting the loop midway is
 * the wrong fix - that could leave a policy in the target account without its conditions,
 * or a workflow bound to a channel that was never created. Instead the loop runs to
 * completion and its state updates are suppressed.
 *
 * Usage: const guard = useMountedGuard();  ...  guard(() => setStep(4));
 */
export function useMountedGuard() {
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return useCallback((update) => {
    if (mounted.current) update();
  }, []);
}
