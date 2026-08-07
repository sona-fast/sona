<script lang="ts">
	let { size = 18 }: { size?: number } = $props();
</script>

<!-- FurTrack logo, monochrome: a bold italic "F" with a trail of paw prints
ascending to the upper-right. Recreated from furtrack.com's favicon, dropping
the brand purple; uses currentColor so it inherits the surrounding text color. -->
<svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
	<!-- italic "F": slanted stem + top and middle bars -->
	<path d="M6.5 3 L9.7 3 L6.7 20 L3.5 20 Z" />
	<path d="M6.5 3 L14 3 L13.4 6.2 L5.9 6.2 Z" />
	<path d="M5.6 9.6 L12 9.6 L11.4 12.6 L5 12.6 Z" />
	<!-- paw-print trail, largest near the F, shrinking toward the upper-right -->
	<ellipse cx="16.4" cy="16.2" rx="1.4" ry="1" />
	<circle cx="15.2" cy="14.5" r="0.5" />
	<circle cx="15.9" cy="13.8" r="0.5" />
	<circle cx="16.9" cy="13.8" r="0.5" />
	<circle cx="17.6" cy="14.5" r="0.5" />
	<ellipse cx="18.7" cy="11.6" rx="1.12" ry="0.8" />
	<circle cx="17.75" cy="10.25" r="0.4" />
	<circle cx="18.3" cy="9.7" r="0.4" />
	<circle cx="19.1" cy="9.7" r="0.4" />
	<circle cx="19.65" cy="10.25" r="0.4" />
	<ellipse cx="20.7" cy="7.3" rx="0.87" ry="0.62" />
	<circle cx="19.95" cy="6.25" r="0.31" />
	<circle cx="20.4" cy="5.8" r="0.31" />
	<circle cx="21" cy="5.8" r="0.31" />
	<circle cx="21.45" cy="6.25" r="0.31" />
</svg>
