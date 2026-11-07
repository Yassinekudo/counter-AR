# ShelfSense AR

Count products on a store shelf with your phone's live camera. Tap one product, give it a name, and every matching item gets a numbered AR pin. A floating label shows the name and total above the product. Pins and labels stay attached to the shelf while you move the phone, and items you have already passed keep counting.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npm run dev
```

Vite prints two addresses:

- **On your computer:** open `https://localhost:5173` and press **Try the demo shelf**. It plays a simulated shelf video, so you can try everything without a camera.
- **On your phone:** connect the phone to the same Wi-Fi and open the `Network` address (for example `https://192.168.1.20:5173`). The certificate is self-signed, so accept the browser warning once (Advanced → Proceed). Phones only allow the camera over HTTPS, which is why the dev server uses it.

### Put it online (best for real phone use)

```bash
npm run build
```

Upload the `dist/` folder to any static HTTPS host, for example by dragging it onto https://app.netlify.com/drop, or by using GitHub Pages or Vercel. Open the link on the phone and choose **Add to Home Screen**. It then opens full screen like a native app and works offline.

## Build the Android APK

The project includes a ready Android app (Capacitor) in `android/`, with camera permission set up.

**Option A: GitHub builds it for you (no Android tools needed).** Push this folder to a GitHub repository. The included workflow `.github/workflows/android-apk.yml` builds the APK on every push to `main`. Open the repo's **Actions** tab, then the latest "Build Android APK" run, and download **ShelfSense-AR-apk**. Copy `app-debug.apk` to your phone and open it (allow "Install unknown apps" once).

**Option B: on your own computer.** Install Android Studio (it brings the Android SDK), then run:

```bash
npm install
npm run apk        # APK at android/app/build/outputs/apk/debug/app-debug.apk
# or: npm run android   (opens the project in Android Studio, then Build > Build APK)
```

## Using it

1. **Start scanning** and aim at a shelf from 0.5 to 2 m away.
2. **Tap a product.** It gets outlined. If the outline is wrong, drag a box around the product instead.
3. **Name it** and press **Count all matching**.
4. **Sweep slowly** along the shelf. The total includes items that have gone off screen.
5. **Fix mistakes.** Tap a wrong item to remove it. Tap a missed item to add it, and the app also learns from it. Use **Tune** to change the match sensitivity.
6. **Save** stores the count, a photo, and the product in your library. Next time, open the **Product library** and press scan to count it again without tapping.

## How it works

| Part | What it does | File |
| --- | --- | --- |
| Camera | Asks for the rear camera at 60 fps and 720p (1080p is optional) with continuous focus. The preview is a plain `<video>`, so it always runs at the camera's full rate. | `src/camera.js` |
| Motion tracking | Each camera frame runs pyramidal Lucas-Kanade optical flow on about 80 feature points, then fits a pan/zoom/roll transform with RANSAC. Chaining these transforms gives a fixed "world" coordinate frame. | `src/vision/tracker.js` |
| Product matching | Runs in a Web Worker so the UI never stutters. It does multi-scale normalised cross-correlation against the tapped product, checks the colour histogram, and applies non-maximum suppression. | `src/vision/vision.worker.js` |
| Tap to select | Finds large uniform background areas (wall, shelf edge, price strip) and takes the blob of product pixels under your finger. | `src/vision/imageops.js` |
| World anchors | Turns detections into world coordinates, merges repeat sightings, and drops items only if they are missed while fully in view. | `src/anchors.js` |
| AR layer | A canvas redrawn on every display frame, with corner brackets, numbered pins and the floating name/count card. | `src/overlay.js` |
| App | Menu, library, history (with CSV export), settings and a PWA shell. All data stays on the device in `localStorage`. | `src/main.js`, `src/store.js` |

No machine-learning model has to be downloaded, so the app starts instantly and works offline. All processing happens on the phone.

## Limits and next steps

- The AR anchoring is image-based. It handles panning, zooming and slight tilting along a shelf well. Walking around a corner or turning the phone sharply can make it drift. For true 3-D anchors, wrap the app with Capacitor and use ARCore/ARKit plane anchors. The matching code can be reused as it is.
- Matching works by appearance. Products with nearly identical packaging (for example two flavours of the same brand) may need a higher threshold: lower the sensitivity under **Tune**.
- Real 60 fps depends on the phone's camera. Most recent Android and iOS phones deliver it at 720p. The HUD in the top-right shows the actual camera and AR frame rates.
