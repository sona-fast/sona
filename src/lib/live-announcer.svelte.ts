// The state behind `LiveAnnouncer.svelte`: what the polite region says, and a
// counter that changes on every write. Re-assigning text the region already
// holds mutates no DOM, and a region that does not change is never read out, so
// the counter is what makes two identical announcements both get spoken.

export class Announcer {
	text = $state('');
	uid = $state(0);

	/** Say `text` out loud, whether or not it is what the region already says. */
	say(text: string) {
		this.text = text;
		this.uid++;
	}
}
