/**
 * Studio's small native pickers: iOS action sheets for a project, an aspect or an engine, and the
 * name prompt for a new project. Native sheets work over the editor's full-screen modal, where the
 * app's bottom sheets would draw underneath it.
 */
import { ActionSheetIOS, Alert } from "react-native";
import { STUDIO_UNSORTED, type StudioProject } from "@relay/protocol";
import { createProject } from "./actions";

/** An action sheet over `options`; resolves with the picked index, or null for Cancel. */
export function chooseFrom(title: string, options: readonly string[]): Promise<number | null> {
  // Executor form: Hermes on the phone predates Promise.withResolvers.
  return new Promise((resolve) => {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...options, "Cancel"], cancelButtonIndex: options.length }, (index) => {
      resolve(index >= options.length ? null : index);
    });
  });
}

/** Asks for a project name and makes the project; undefined when Isaac backs out or the host refuses. */
export async function newProject(): Promise<StudioProject | undefined> {
  const name = await new Promise<string | null>((resolve) => {
    Alert.prompt("New project", undefined, [
      {
        text: "Cancel",
        style: "cancel",
        onPress: () => {
          resolve(null);
        },
      },
      {
        text: "Create",
        onPress: (value?: string) => {
          resolve(value?.trim() ?? null);
        },
      },
    ]);
  });
  if (name === null || name.length === 0) return undefined;
  return createProject(name);
}

/** A project id (STUDIO_UNSORTED for Unsorted), or follow the open project (the create bar's target). */
export type ProjectChoice = { kind: "project"; id: string } | { kind: "follow" };

/**
 * Unsorted, every project, New project (asks for a name and makes it) and, with `follow`, "Follow
 * the open project". Null when Isaac backs out.
 */
export async function pickProject(title: string, projects: readonly StudioProject[], follow = false): Promise<ProjectChoice | null> {
  const options = ["Unsorted", ...projects.map((p) => p.name), "New project", ...(follow ? ["Follow the open project"] : [])];
  const index = await chooseFrom(title, options);
  if (index === null) return null;
  if (index === 0) return { kind: "project", id: STUDIO_UNSORTED };
  const project = projects[index - 1];
  if (project !== undefined) return { kind: "project", id: project.id };
  if (index === projects.length + 1) {
    const made = await newProject();
    return made === undefined ? null : { kind: "project", id: made.id };
  }
  return { kind: "follow" };
}
