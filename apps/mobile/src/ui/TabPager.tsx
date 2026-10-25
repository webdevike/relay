import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { spacing } from "@/theme";
import { Pager, usePager } from "@/ui/Pager";
import { SegmentedTabs } from "@/ui/SegmentedTabs";

export interface TabPagerProps {
  /** One label per page, in page order. */
  labels: readonly string[];
  /** One pane per label. */
  children: ReactNode[];
}

/**
 * Tabs whose panes sit side by side in a `Pager`: tap a tab or swipe sideways between panes, and the
 * selected tab follows the swipe. The pager takes the shown pane's height, so a short pane leaves no
 * gap under it. Every pane stays mounted, so a pane keeps its state (checked rows, playback) when
 * you swipe away and back.
 */
export function TabPager({ labels, children }: TabPagerProps) {
  const [width, setWidth] = useState(0);
  const { page, setPage, go } = usePager(labels.length);
  return (
    <View style={{ gap: spacing.md }}>
      <SegmentedTabs
        tabs={labels.map((label, i) => ({ key: String(i), label }))}
        value={String(page)}
        onChange={(key) => {
          go(Number(key));
        }}
      />
      <View
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
        }}
      >
        <Pager width={width} page={page} onPageChange={setPage} fitPage>
          {children}
        </Pager>
      </View>
    </View>
  );
}
