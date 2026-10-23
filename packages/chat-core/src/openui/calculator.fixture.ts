/**
 * Relay's calculator prompt example (`CALCULATOR` in
 * ~/Eva/work/relay/packages/protocol/src/openui/prompt.ts at commit ac61677), copied for tests: a
 * pocket calculator's immediate execution (each operator applies the pending one to the running
 * total), kept in $acc/$op/$cur with arithmetic per operator. Button action ids are the statement
 * names (k0-k9, kdot, kadd, ksub, kmul, kdiv, keq, clear).
 */
export const CALCULATOR = `root = Card([screen, keys, clear], "Calculator")
$display = "0"
$cur = ""
$acc = 0
$op = ""
screen = Text($display, "heading")
keys = Grid([k7, k8, k9, kdiv, k4, k5, k6, kmul, k1, k2, k3, ksub, k0, kdot, keq, kadd], 4, "xs")
result = $cur == "" ? $acc : ($op == "+" ? $acc + $cur * 1 : ($op == "-" ? $acc - $cur : ($op == "*" ? $acc * $cur : ($op == "/" ? $acc / $cur : $cur * 1))))
k7 = Button("7", Action([@Set($cur, $cur + "7"), @Set($display, $cur)]))
k8 = Button("8", Action([@Set($cur, $cur + "8"), @Set($display, $cur)]))
k9 = Button("9", Action([@Set($cur, $cur + "9"), @Set($display, $cur)]))
k4 = Button("4", Action([@Set($cur, $cur + "4"), @Set($display, $cur)]))
k5 = Button("5", Action([@Set($cur, $cur + "5"), @Set($display, $cur)]))
k6 = Button("6", Action([@Set($cur, $cur + "6"), @Set($display, $cur)]))
k1 = Button("1", Action([@Set($cur, $cur + "1"), @Set($display, $cur)]))
k2 = Button("2", Action([@Set($cur, $cur + "2"), @Set($display, $cur)]))
k3 = Button("3", Action([@Set($cur, $cur + "3"), @Set($display, $cur)]))
k0 = Button("0", Action([@Set($cur, $cur + "0"), @Set($display, $cur)]))
kdot = Button(".", Action([@Set($cur, $cur + "."), @Set($display, $cur)]))
kdiv = Button("÷", Action([@Set($acc, result), @Set($op, "/"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
kmul = Button("×", Action([@Set($acc, result), @Set($op, "*"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
ksub = Button("−", Action([@Set($acc, result), @Set($op, "-"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
kadd = Button("+", Action([@Set($acc, result), @Set($op, "+"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
keq = Button("=", Action([@Set($acc, result), @Set($op, ""), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "primary")
clear = Button("Clear", @Reset($display, $cur, $acc, $op), null, "subtle")`
