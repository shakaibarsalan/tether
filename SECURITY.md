# Security

Tether is a security tool, so please report weaknesses privately.

**Report through GitHub:** go to [Security → Report a vulnerability](https://github.com/shakaibarsalan/tether/security/advisories/new)
on this repository. Please don't open a public issue for something exploitable.

Especially interesting:

- a way for a Claude session on **another computer** to drive the browser while the bridge block is on;
- a way past the guard hook (a browser tool that runs without the owner's browser being confirmed);
- the scripts changing anything beyond the hosts lines, hook entries and files they document.

Issues in Claude, the Claude in Chrome extension or Chrome itself belong with
[Anthropic](https://www.anthropic.com/responsible-disclosure-policy) or
[Google](https://bughunters.google.com/). Tether only works around their behaviour.
