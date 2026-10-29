/**
 * Studio: make images and video on the host. The composer on top, jobs in progress under it, then
 * the gallery of finished outputs; Generate sits in the bottom bar where the thumb reaches. Paid
 * backends go through the confirm sheet; free ones start at once.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from "react-native";
import { studioJobActive } from "@relay/protocol";
import { requestStudio, studioRequest } from "@/connection";
import { useStudioStore } from "@/state/studio";
import { spacing } from "@/theme";
import { BottomBar } from "@/ui/BottomBar";
import { Button } from "@/ui/Button";
import { EmptyState } from "@/ui/EmptyState";
import { IconButton } from "@/ui/IconButton";
import { Screen } from "@/ui/Screen";
import { Separator } from "@/ui/Separator";
import { Text } from "@/ui/Text";
import { ThumbGrid } from "@/ui/ThumbGrid";
import { Toast } from "@/ui/Toast";
import { assetLength, assetsById, galleryItems, useHostBase } from "@/studio/assets";
import { Composer, quoteLine } from "@/studio/Composer";
import { draftSpec, formProblem, studioForm } from "@/studio/draft";
import { GallerySheet } from "@/studio/GallerySheet";
import { ModelSheet } from "@/studio/ModelSheet";
import { PaidConfirmSheet } from "@/studio/PaidConfirmSheet";
import { QueueRow } from "@/studio/QueueRow";
import { useQuote } from "@/studio/quote";
import { StudioViewer } from "@/studio/StudioViewer";
import { useStudio } from "@/studio/useStudio";

export default function Studio() {
  const jobs = useStudioStore((state) => state.jobs);
  const uploads = useStudioStore((state) => state.uploads);
  const backends = useStudioStore((state) => state.backends);
  const loaded = useStudioStore((state) => state.loaded);
  const draft = useStudioStore((state) => state.draft);
  const patchDraft = useStudioStore((state) => state.patchDraft);
  const base = useHostBase();
  const scroll = useRef<ScrollView>(null);
  const [models, setModels] = useState(false);

  // The host pushes every change while connected; asking on open covers a list missed in between.
  useEffect(() => {
    requestStudio();
  }, []);

  const form = useMemo(() => studioForm(draft, backends), [draft, backends]);
  const assets = useMemo(() => assetsById(jobs, uploads), [jobs, uploads]);
  const gallery = useMemo(() => galleryItems(jobs), [jobs]);
  const queue = jobs.filter((job) => studioJobActive(job) || job.state === "failed");
  const pickable = useMemo(() => [...uploads, ...gallery.map((item) => item.asset)].filter((asset) => asset.kind === "image").sort((a, b) => b.createdAt - a.createdAt), [uploads, gallery]);
  const problem = formProblem(form);
  const quote = useQuote(draftSpec(form), form.backend?.paid === true);
  const studio = useStudio(form, () => {
    scroll.current?.scrollTo({ y: 0, animated: true });
  });
  const running = queue.filter(studioJobActive).length;
  const hint = problem ?? (form.backend?.paid === true ? quoteLine(quote, form.backend.balance) : running > 0 ? `${running} in progress` : "");

  return (
    <Screen
      title="Studio"
      headerRight={
        <IconButton
          symbol="arrow.clockwise"
          size={44}
          accessibilityLabel="Refresh backends"
          onPress={() => {
            void studioRequest({ kind: "refresh" });
          }}
        />
      }
    >
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        <ScrollView ref={scroll} style={styles.fill} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          {loaded || backends.length > 0 ? (
            <Composer
              form={form}
              assets={assets}
              base={base}
              quote={quote}
              uploading={studio.uploading}
              onPatch={patchDraft}
              onAdd={(target) => {
                void studio.add(target);
              }}
              onOpenAsset={(asset) => {
                studio.view({ asset, job: jobs.find((job) => job.outputs.some((output) => output.id === asset.id)) });
              }}
              onOpenModels={() => {
                setModels(true);
              }}
            />
          ) : (
            <EmptyState symbol="wand.and.stars" title="Waiting for your Mac" body="Studio runs on the host. It shows up here once the phone is connected." />
          )}

          {queue.length > 0 && (
            <View style={styles.section}>
              <Text variant="label" color="textMuted" style={styles.heading}>
                In progress
              </Text>
              {queue.map((job, index) => {
                const start = job.spec.frames?.start ?? job.spec.refs?.[0];
                const startAsset = start === undefined ? undefined : assets.get(start);
                return (
                  <View key={job.id}>
                    {index > 0 && <Separator />}
                    <QueueRow
                      job={job}
                      backendLabel={backends.find((b) => b.id === job.spec.backend)?.label ?? job.spec.backend}
                      thumb={startAsset === undefined || base === null ? null : `${base}${startAsset.thumb}`}
                      busy={studio.busyJob === job.id}
                      onCancel={() => {
                        void studio.cancel(job);
                      }}
                      onDismiss={() => {
                        void studio.dismiss(job);
                      }}
                      onRemix={() => {
                        studio.remix(job);
                      }}
                    />
                  </View>
                );
              })}
            </View>
          )}

          {loaded && (
            <View style={[styles.section, styles.gallery]}>
              <Text variant="label" color="textMuted">
                Gallery
              </Text>
              {gallery.length === 0 ? (
                <Text variant="body" color="textMuted">
                  Nothing made yet. Describe something above and tap Generate.
                </Text>
              ) : (
                <ThumbGrid
                  items={gallery.map(({ asset, job }) => ({
                    key: asset.id,
                    uri: base === null ? null : `${base}${asset.thumb}`,
                    length: assetLength(asset),
                    accessibilityLabel: job.spec.prompt,
                  }))}
                  onPress={(key) => {
                    const item = gallery.find((entry) => entry.asset.id === key);
                    if (item !== undefined) studio.view(item);
                  }}
                />
              )}
            </View>
          )}
        </ScrollView>

        {studio.message !== null && studio.viewing === null && (
          <View style={styles.toast} pointerEvents="none">
            <Toast message={studio.message} />
          </View>
        )}

        <BottomBar>
          {hint.length > 0 && (
            <Text variant="caption" color={problem === undefined ? "textMuted" : "warn"} numberOfLines={2} style={styles.hint}>
              {hint}
            </Text>
          )}
          <Button
            label="Generate"
            height={50}
            disabled={problem !== undefined}
            loading={studio.generating && studio.confirm === null}
            onPress={() => {
              void studio.generate();
            }}
          />
        </BottomBar>
      </KeyboardAvoidingView>

      <ModelSheet
        visible={models}
        draft={draft}
        backends={backends}
        onPick={(model) => {
          patchDraft({ model });
          setModels(false);
        }}
        onClose={() => {
          setModels(false);
        }}
      />
      <GallerySheet
        visible={studio.picking !== null}
        title={studio.picking === "ref" ? "Pick a reference" : "Pick a frame"}
        images={pickable}
        base={base}
        onPick={studio.pick}
        onClose={studio.closePicker}
      />
      <PaidConfirmSheet
        spec={studio.confirm?.spec ?? null}
        provider={(form.backend?.label ?? "Higgsfield").replace(/\s*\(.*\)$/, "")}
        balance={form.backend?.balance}
        sending={studio.generating}
        error={studio.confirm?.error ?? null}
        onConfirm={(credits) => {
          void studio.confirmPaid(credits);
        }}
        onClose={studio.closeConfirm}
      />
      <StudioViewer
        asset={studio.viewing?.asset ?? null}
        uri={studio.viewing === null || base === null ? null : `${base}${studio.viewing.asset.path}`}
        canRemix={studio.viewing?.job !== undefined}
        busy={studio.viewerBusy}
        message={studio.message}
        onAction={studio.viewerAction}
        onClose={studio.closeViewer}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingBottom: spacing.xxl },
  section: { marginTop: spacing.xxl },
  heading: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xs },
  gallery: { paddingHorizontal: spacing.xl, gap: spacing.sm },
  hint: { textAlign: "center" },
  toast: { position: "absolute", left: 0, right: 0, bottom: 120 },
});
