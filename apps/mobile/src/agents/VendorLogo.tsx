import { Image, type ImageSourcePropType } from "react-native";
import { Text } from "@/ui/Text";

/* eslint-disable @typescript-eslint/no-require-imports -- static asset table; Metro needs literal requires */
const logos: Record<string, ImageSourcePropType> = {
  anthropic: require("../../assets/vendors/anthropic.png") as ImageSourcePropType,
  openai: require("../../assets/vendors/openai.png") as ImageSourcePropType,
  google: require("../../assets/vendors/google.png") as ImageSourcePropType,
  xai: require("../../assets/vendors/xai.png") as ImageSourcePropType,
  deepseek: require("../../assets/vendors/deepseek.png") as ImageSourcePropType,
  meta: require("../../assets/vendors/meta.png") as ImageSourcePropType,
  mistral: require("../../assets/vendors/mistral.png") as ImageSourcePropType,
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
}

/** Company mark in its brand color (marks that are black on light surfaces are white here), or the vendor's name when we have none. */
export function VendorLogo({ vendor, size = 14 }: VendorLogoProps) {
  const source = logos[vendor];
  if (source === undefined) {
    return (
      <Text variant="caption" color="textFaint">
        {vendorLabel(vendor)}
      </Text>
    );
  }
  return <Image source={source} style={{ width: size, height: size }} resizeMode="contain" />;
}
