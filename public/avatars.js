// The avatars players can pick. Shared by the server (which only accepts these) and the page.
(function (root) {
  const AVATARS = [
    '🦊', '🐼', '🐸', '🦁', '🐙', '🦉', '🐯', '🐨',
    '🐵', '🦄', '🐧', '🐢', '🐝', '🐳', '🦖', '🐱',
    '🐶', '🐰', '🐻', '🦀', '🍕', '🌵', '👾', '🤖',
  ];
  if (typeof module !== 'undefined' && module.exports) module.exports = AVATARS;
  else root.AVATARS = AVATARS;
})(this);
