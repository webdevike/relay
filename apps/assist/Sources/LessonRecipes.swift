import Foundation

/// Lessons Relay Assist knows by heart: fixed steps with checks written against the app's live state,
/// so the lesson starts at once (no model plan) and every tick comes from the scene itself.
struct LessonRecipe {
    let title: String
    let steps: [LessonStep]
}

enum LessonRecipes {
    /// The recipe for `goal` in the app `hook` talks to, or nil (the model plans the lesson).
    static func match(goal: String, hook: AppHook?) -> LessonRecipe? {
        guard hook is BlenderHook else { return nil }
        let words = goal.lowercased()
        if words.contains("donut") || words.contains("doughnut") { return blenderDonut }
        return nil
    }

    /// The classic Blender beginner donut: a torus shaped, subdivided and shaded smooth, then its top
    /// duplicated and separated into an icing object with a Solidify for thickness. Checks read every
    /// torus object, so they hold whichever one is active; the mode and selection steps pass (the next
    /// steps leave them), everything else lasts.
    static let blenderDonut = LessonRecipe(title: "Make a donut", steps: [
        LessonStep(title: "Add a torus",
                   instruction: "Press Shift+A, then pick Mesh and Torus to add the donut's dough.",
                   doneCheck: "any(o.type == 'MESH' and o.name.startswith('Torus') for o in scene.objects)"),
        LessonStep(title: "Shape the dough",
                   instruction: "Press S and move your mouse to resize the donut, then click to confirm.",
                   doneCheck: "any(o.type == 'MESH' and o.name.startswith('Torus') and abs(max(o.dimensions) - 2.5) > 0.05 for o in scene.objects)"),
        LessonStep(title: "Smooth the shape",
                   instruction: "Press Ctrl+2 to add a Subdivision Surface and round off the shape.",
                   doneCheck: "any(m.type == 'SUBSURF' for o in scene.objects if o.name.startswith('Torus') for m in o.modifiers)"),
        LessonStep(title: "Shade smooth",
                   instruction: "Right-click the donut and choose Shade Smooth to hide the facets.",
                   doneCheck: "any(o.type == 'MESH' and o.name.startswith('Torus') and len(o.data.polygons) > 0 and all(p.use_smooth for p in o.data.polygons) for o in scene.objects)"),
        LessonStep(title: "Edit Mode",
                   instruction: "Press Tab to go into Edit Mode, where you'll pick the faces for the icing.",
                   doneCheck: "mode == 'EDIT_MESH'", lasting: false),
        LessonStep(title: "Select the top half",
                   instruction: "Press Alt+Z to see through, then drag a box over the top half of the donut.",
                   doneCheck: "mode == 'EDIT_MESH' and obj is not None and 0 < sum(v.select for v in obj.data.vertices) < len(obj.data.vertices) and sum(v.co.z for v in obj.data.vertices if v.select) > 0",
                   lasting: false),
        LessonStep(title: "Make the icing",
                   instruction: "Press Shift+D, right-click to keep it in place, then press P and pick Selection.",
                   doneCheck: "sum(1 for o in scene.objects if o.type == 'MESH' and o.name.startswith('Torus')) >= 2"),
        LessonStep(title: "Select the icing",
                   instruction: "Press Tab to go back to Object Mode, then click the icing to select it.",
                   doneCheck: "mode == 'OBJECT' and obj is not None and obj.name.startswith('Torus.')", lasting: false),
        LessonStep(title: "Thicken the icing",
                   instruction: "In the wrench tab, click Add Modifier, Generate, then Solidify for thickness.",
                   doneCheck: "any(m.type == 'SOLIDIFY' for o in scene.objects if o.type == 'MESH' for m in o.modifiers)"),
    ])
}
