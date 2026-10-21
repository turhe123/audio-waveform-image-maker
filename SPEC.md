# Audio Waveform Image Maker — specification

**Tagline:** Turn any audio file into a waveform picture as PNG or SVG in your browser, with no watermark.

**Category:** Audio & Video

**Free alternative to:** Kapwing and Veed audio waveform visualizers (watermark on free exports, account required, upload to cloud, paid plans from about 16 USD per month)

**Search phrases:** audio waveform generator, waveform image from audio, waveform viewer online, mp3 waveform png, audio to waveform svg, soundwave art generator, waveform visualizer free

**Allowed libraries:** none (browser APIs only)

**Published at:** https://turhe123.github.io/audio-waveform-image-maker/

## Acceptance checks (each must have a test)

- Loading sample-song.mp3 draws a waveform preview in the default colors
- Changing bar style to Bars and color to a new value updates the preview
- Download PNG yields an image of the chosen width and height
- Download SVG yields a file that contains path or rect elements
- A transparent background option produces a PNG with alpha
- Works at 390px wide

## Spec

People search for audio waveform generator, waveform image from mp3 and soundwave art for podcast covers, wedding vow prints, music posters, thumbnails and social posts. Video platform tools offer it, but exports carry a watermark on the free tier, require an account and upload the audio to a cloud. Dedicated viewers are desktop programs. Our version draws a clean waveform of a local audio file and saves it as an image, which is one job.

Feature set: load one audio file. Choose style: Mirrored lines, Bars (default) or Outline. Choose bar width and gap, color or two color gradient, background color or transparent, image size by preset (1080 by 1080, 1920 by 1080, 1500 by 500, custom up to 4000 pixels) and an optional range of the audio to draw by start and end time. Also show duration, sample rate and peak level as a small info line, which makes the tool useful as a waveform viewer. Export PNG and SVG. No text overlays and no video output.

UI: a drop zone at the top, then a large live preview canvas, and beside or below it the options panel with sensible defaults so the first result already looks good. Download PNG and Download SVG buttons sit under the preview. Output names follow the audio file name with the word waveform. Empty state shows a sample preview. Errors for undecodable files are inline. On phones the options collapse under the preview. Keyboard: tab through controls, Enter downloads PNG.

Technical approach: decode with AudioContext decodeAudioData, mix channels, then compute peaks. For N columns split the samples into N windows and take the maximum absolute value, optionally the root mean square for a softer look, normalized to the loudest peak. Draw to a canvas at device pixel ratio using rounded rectangles or lines. For PNG use canvas toBlob. For SVG build the same shapes as a string of rect or path elements with the same dimensions and colors, and download a Blob of type image svg xml. Redraw with requestAnimationFrame when options change, and debounce slider input. A Web Worker computes peaks for files longer than ten minutes to keep the interface responsive.

Edge cases: very long files make memory heavy so warn above about one hour of stereo audio. Silence-only files should draw a flat line and say so. Mono files are drawn the same as stereo mixes. Large canvases above browser limits on mobile Safari should be clamped to a safe pixel count with a message. Transparent PNG previews should show a checkerboard. Unicode file names are kept.

Demo data: a bundled twelve second generated audio called Sample Song with three loud sections and quiet gaps, so bars of different heights are visible immediately.
