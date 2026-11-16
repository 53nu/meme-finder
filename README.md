# Meme Finder

A browser-based project that matches a facial expression to reaction memes. p5.js draws the camera preview. face-api.js detects faces, estimates 68 facial landmarks, and scores seven facial expressions.

## Run locally

From the repository directory, run:

```sh
python3 -m http.server 8000
```

Open http://localhost:8000. Use the camera or upload a photo. The default capture timer is three seconds. Internet access is used to load the client libraries, model weights, and meme images.

## How matching works

The app checks that one prominent face is visible, then compares the seven expression scores and the geometry of the eyes, eyebrows, and mouth. The final distance combines expression scores at 55% and landmark measurements at 45%. The library contains 38 curated meme images with precomputed profiles. The app returns up to three qualified matches and shows the expression scores used in the comparison.

Camera frames and uploaded photos are analyzed in the browser. Meme images and source pages are linked in `memes.json`.

- [face-api.js](https://github.com/justadudewhohacks/face-api.js/tree/0.22.2)
- [p5.js](https://p5js.org/)
