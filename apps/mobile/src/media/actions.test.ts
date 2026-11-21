import { beforeEach, describe, expect, it, vi } from "vitest";
import { PHOTOS_DENIED } from "@/drops/actions";
import { useMediaNotice } from "@/state/mediaNotice";
import { saveMedia, sniffExtension } from "./actions";

const photos = vi.hoisted(() => ({
  status: { granted: false, canAskAgain: true },
  answer: { granted: false, canAskAgain: false },
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  saveToLibraryAsync: vi.fn(),
  downloads: [] as string[],
}));

vi.mock("expo-media-library", () => ({
  getPermissionsAsync: photos.getPermissionsAsync,
  requestPermissionsAsync: photos.requestPermissionsAsync,
  saveToLibraryAsync: photos.saveToLibraryAsync,
}));
vi.mock("expo-file-system", () => {
  class Directory {
    create = () => undefined;
    list = () => [];
  }
  class File {
    uri: string;
    name: string;
    constructor(_dir: unknown, name: string) {
      this.name = name;
      this.uri = `file:///cache/media/${name}`;
    }
    open = () => ({ readBytes: () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), close: () => undefined });
    rename = (name: string) => {
      this.name = name;
      this.uri = `file:///cache/media/${name}`;
    };
    static downloadFileAsync = (url: string, file: File) => {
      photos.downloads.push(url);
      return Promise.resolve(file);
    };
  }
  return { Directory, File, Paths: { cache: "/cache" } };
});
vi.mock("react-native", () => ({ ActionSheetIOS: { showActionSheetWithOptions: vi.fn() }, Share: { share: vi.fn() } }));
vi.mock("expo-clipboard", () => ({ setImageAsync: vi.fn() }));
vi.mock("@/lib/haptics", () => ({ notifyHaptic: vi.fn() }));
vi.mock("@/connection/log", () => ({ warn: vi.fn() }));

const IMAGE = { uri: "https://host.example/drops/abc/token", kind: "image" } as const;

beforeEach(() => {
  photos.getPermissionsAsync.mockReset().mockImplementation(() => Promise.resolve(photos.status));
  photos.requestPermissionsAsync.mockReset().mockImplementation(() => Promise.resolve(photos.answer));
  photos.saveToLibraryAsync.mockReset().mockResolvedValue(undefined);
  photos.downloads.length = 0;
  useMediaNotice.setState({ notice: null });
});

describe("saveMedia", () => {
  it("never asks again once Photos access was refused, and fetches nothing", async () => {
    photos.status = { granted: false, canAskAgain: false };
    await saveMedia(IMAGE);
    await saveMedia(IMAGE);
    expect(photos.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(photos.downloads).toEqual([]);
    expect(photos.saveToLibraryAsync).not.toHaveBeenCalled();
    expect(useMediaNotice.getState().notice).toBe(PHOTOS_DENIED);
  });

  it("asks for add-only access the first time and says so when it is declined", async () => {
    photos.status = { granted: false, canAskAgain: true };
    photos.answer = { granted: false, canAskAgain: false };
    await saveMedia(IMAGE);
    expect(photos.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(photos.requestPermissionsAsync).toHaveBeenCalledWith(true);
    expect(photos.downloads).toEqual([]);
    expect(useMediaNotice.getState().notice).toBe(PHOTOS_DENIED);
  });

  it("saves the fetched bytes under their sniffed extension once access is granted", async () => {
    photos.status = { granted: true, canAskAgain: true };
    await saveMedia(IMAGE);
    expect(photos.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(photos.downloads).toEqual([IMAGE.uri]);
    expect(photos.saveToLibraryAsync).toHaveBeenCalledWith("file:///cache/media/relay-image.jpg");
    expect(useMediaNotice.getState().notice).toBe("Saved to Photos");
  });
});

describe("sniffExtension", () => {
  const bytes = (...parts: (string | number[])[]) =>
    Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));

  it("names the formats Photos takes", () => {
    expect(sniffExtension(bytes([0xff, 0xd8, 0xff, 0xdb]))).toBe("jpg");
    expect(sniffExtension(bytes([0x89], "PNG\r\n"))).toBe("png");
    expect(sniffExtension(bytes("GIF89a"))).toBe("gif");
    expect(sniffExtension(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toBe("webp");
    expect(sniffExtension(bytes([0, 0, 0, 0x18], "ftypheic"))).toBe("heic");
    expect(sniffExtension(bytes([0, 0, 0, 0x14], "ftypqt  "))).toBe("mov");
    expect(sniffExtension(bytes([0, 0, 0, 0x20], "ftypisom"))).toBe("mp4");
    expect(sniffExtension(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBe("webm");
  });

  it("knows nothing else", () => {
    expect(sniffExtension(bytes("glTF", [2, 0, 0, 0]))).toBeNull();
    expect(sniffExtension(new Uint8Array(0))).toBeNull();
  });
});
