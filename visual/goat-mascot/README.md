# The Katse goat (archived)

The voice goat that sat in the bottom-right corner was replaced by the white aura around the screen (`mvp/voice/`).
Its art is kept here: `goat.js` is the self-contained SVG rig with 12 animated states (idle, listening, talking,
thinking, sleeping, happy, surprised, sad, confused, love, bleating) and a 2.5D look-at.

The whole integration as it was (goat button, conversation panel, `mascot.css`, `mascot.js`) is in git at the tag
`goat-mascot`:

    git show goat-mascot:mvp/mascot/mascot.js
    git checkout goat-mascot -- mvp/mascot     # bring it all back
