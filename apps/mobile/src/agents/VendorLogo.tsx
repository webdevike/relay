import { Image, type ImageSourcePropType } from "react-native";
import { Text } from "@/ui/Text";

/* eslint-disable @typescript-eslint/no-require-imports -- static asset table; Metro needs literal requires */
const logos: Record<string, ImageSourcePropType> = {
  anthropic: require<ImageSourcePropType>("../../assets/vendors/anthropic.png"),
  openai: require<ImageSourcePropType>("../../assets/vendors/openai.png"),
  google: require<ImageSourcePropType>("../../assets/vendors/google.png"),
  xai: require<ImageSourcePropType>("../../assets/vendors/xai.png"),
  deepseek: require<ImageSourcePropType>("../../assets/vendors/deepseek.png"),
  meta: require<ImageSourcePropType>("../../assets/vendors/meta.png"),
  mistral: require<ImageSourcePropType>("../../assets/vendors/mistral.png"),
};
/* eslint-enable @typescript-eslint/no-require-imports */

export const vendorNames: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  meta: "Meta",
  mistral: "Mistral",
  unknown: "Other",
};

export function vendorLabel(vendor: string): string {
  return vendorNames[vendor] ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

/** The vendor's brand word that its model names repeat ("Claude Fable 5.1" reads as "Fable 5.1" next to the logo). */
const brandPrefix: Record<string, RegExp> = {
  anthropic: /^Claude\s+/,
  google: /^Gemini\s+/,
};

export function modelShortName(name: string, vendor: string | undefined): string {
  const prefix = vendor === undefined ? undefined : brandPrefix[vendor];
  return prefix === undefined ? name : name.replace(prefix, "");
}

export interface VendorLogoProps {
  vendor: string;
  size?: number;
  /** Tint; the assets are light glyphs on transparent, so this darkens/colors them. */
  tintColor?: string;
}

/** Monochrome company mark, or the vendor's name when we have no mark for it. */
export function VendorLogo({ vendor, size = 14, tintColor }: VendorLogoProps) {
  const source = logos[vendor];
  if (source === undefined) {
    return (
      <Text variant="caption" color="textFaint">
        {vendorLabel(vendor)}
      </Text>
    );
  }
  return <Image source={source} style={{ width: size, height: size, ...(tintColor === undefined ? {} : { tintColor }) }} resizeMode="contain" />;
}
