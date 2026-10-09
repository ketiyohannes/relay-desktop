/** Apply action replacements in place without discarding previously loaded history. */
export function mergeDesktopUpdate(state, update) {
  const session = state.sessions.find((session) => session.id === update.session.id);
  if (!session) { state.sessions.push(update.session); }
  else {
    const actions = session.actions;
    const positions = new Map(actions.map((action, index) => [action.id, index]));
    for (const action of update.session.actions) {
      const index = positions.get(action.id);
      if (index === undefined) { positions.set(action.id, actions.length); actions.push(action); }
      else actions[index] = action;
    }
    Object.assign(session, update.session, { actions });
  }
  state.busySession = update.busySession;
}
