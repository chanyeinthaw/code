import { Image, type ColorValue } from "react-native";

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Image
      accessibilityLabel="Sora"
      source={require("../../../../assets/sora/mark.png")}
      style={{ width: props.height, height: props.height }}
    />
  );
}
