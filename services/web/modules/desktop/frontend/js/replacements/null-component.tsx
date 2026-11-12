/**
 * Stands in for components of features the desktop app does not have
 * (sharing, collaborators, history, ...). See ../../../replacements.js.
 */
export default function NullComponent() {
  return null;
}

// Some of the replaced modules use named exports.
export const OnlineUsers = NullComponent;
