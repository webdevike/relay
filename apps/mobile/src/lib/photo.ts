import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { MAX_IMAGE_BASE64, type AgentImage } from "@relay/protocol";

/** Longest edge a sent photo keeps: plenty to see the proof, and well inside one frame's image limit. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.8;

export type PhotoSource = "camera" | "library";

export interface Photo {
  /** What goes over the wire. */
  image: AgentImage;
  /** Local file of the same JPEG, for a preview. */
  uri: string;
  width: number;
  height: number;
}

/** Scales a picked asset down to `maxEdge` and re-encodes it as JPEG. */
async function encodeAsset(asset: ImagePicker.ImagePickerAsset, maxEdge = MAX_EDGE): Promise<Photo> {
  const context = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > maxEdge) context.resize(asset.width >= asset.height ? { width: maxEdge } : { height: maxEdge });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY, base64: true });
  if (saved.base64 === undefined || saved.base64.length === 0) throw new Error("The photo could not be encoded.");
  if (saved.base64.length > MAX_IMAGE_BASE64) throw new Error("The photo is too large to send.");
  return { image: { mimeType: "image/jpeg", data: saved.base64 }, uri: saved.uri, width: saved.width, height: saved.height };
}

/**
 * A photo taken now or picked from the library, scaled down to `maxEdge` (MAX_EDGE unless the
 * caller needs more, like Studio's 2048 px reference frames) and re-encoded as JPEG. Null when the
 * user backs out; throws when camera access is denied. The library uses the system picker, which
 * needs no permission.
 */
export async function choosePhoto(source: PhotoSource, maxEdge = MAX_EDGE): Promise<Photo | null> {
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error("Relay needs camera access in Settings to take the photo.");
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1 };
  const result = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? undefined : result.assets[0];
  if (asset === undefined) return null;
  return encodeAsset(asset, maxEdge);
}

/** Up to `limit` library photos in one pick, each scaled and encoded as `choosePhoto` does. Empty when the user backs out. */
export async function chooseLibraryPhotos(limit: number): Promise<Photo[]> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, allowsMultipleSelection: true, selectionLimit: limit });
  if (result.canceled) return [];
  return Promise.all(result.assets.slice(0, limit).map((asset) => encodeAsset(asset)));
}
