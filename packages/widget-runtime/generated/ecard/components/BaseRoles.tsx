// @ts-nocheck: copied verbatim from eCardSystems/react-client-reports-app@0f691613 src/design-system/components/BaseRoles.tsx by scripts/sync-ecard-design.ts (CSS module import inlined as its class map); type-checked in its own repo.
// Semantic role components (ENG-6180): the repeated card/row/detail/ledger/page-title CSS-module
// blocks, owned once by the design system. Override with style props (p, m, fz, lh, c, ...).
// Plain functions, not Paper.withProps()/createPolymorphicComponent(), so @design-system makes no
// load-time Mantine calls (see theme.ts).
import {
  Box, Paper, Text, Title,
  type BoxProps, type ElementProps, type PaperProps, type PolymorphicComponentProps, type TextProps, type TitleProps,
} from "@mantine/core";
import type {
  ReactElement, ReactNode, 
} from "react";
const classes: Record<string, string> = {"card-title":"ecard-BaseRoles-card-title","row-title":"ecard-BaseRoles-row-title","detail-label":"ecard-BaseRoles-detail-label","detail-value":"ecard-BaseRoles-detail-value","ledger-row":"ecard-BaseRoles-ledger-row","ledger-label":"ecard-BaseRoles-ledger-label","ledger-value":"ecard-BaseRoles-ledger-value","page-body":"ecard-BaseRoles-page-body","page-header":"ecard-BaseRoles-page-header","page-title":"ecard-BaseRoles-page-title","page-description":"ecard-BaseRoles-page-description"};

// Same call signature createPolymorphicComponent gives Mantine components (`component` prop + its props).
type BasePolymorphic<DefaultComponent, Props> = <C = DefaultComponent>(
  props: PolymorphicComponentProps<C, Props>,
) => ReactElement;

function joinClassNames(roleClassName: string, className?: string) {
  return className ? `${roleClassName} ${className}` : roleClassName;
}

// Replaces the bordered `padding: 16px` card blocks: `.card` in OrderPaymentCard,
// OrderPurchaserBillingCard, OrderDisputeCard, OrderTimelineCard, OrderPlatformFeeCard and
// `.summary-card` in EgiftOrderListView (all on BasePaper withBorder radius="md").
export type BasePanelProps = PaperProps;
function BasePanelRoot(props: BasePanelProps) {
  return <Paper withBorder radius={"md"} p={"md"} {...props} />;
}
export const BasePanel = BasePanelRoot as BasePolymorphic<"div", BasePanelProps>;

// Replaces the 16px/600 card `.title` in OrderDisputeCard, OrderPaymentCard,
// OrderPurchaserBillingCard, OrderTimelineCard, OrderPlatformFeeCard (BaseText h2, color inherited
// from body), PageLinkCard and HomeWidgetHeader. Renders an h2; margin 0 unless m/mb/... is passed.
export type BaseCardTitleProps = TextProps;
function BaseCardTitleRoot({
  className, ...others 
}: BaseCardTitleProps) {
  return (<Text
    component={"h2"} {...others} className={joinClassNames(classes["card-title"],
      className)}
  />);
}
export const BaseCardTitle = BaseCardTitleRoot as BasePolymorphic<"h2", BaseCardTitleProps>;

// Replaces the single-line 14px/600 `.title` in OrderCard, OrderLineItemCard, CustomerCard,
// StorefrontCard, CustomCardPrintFlowJobCard, PlatformAssetCard and DataCard.
export type BaseRowTitleProps = TextProps;
function BaseRowTitleRoot({
  className, ...others 
}: BaseRowTitleProps) {
  return (<Text
    {...others} className={joinClassNames(classes["row-title"],
      className)}
  />);
}
export const BaseRowTitle = BaseRowTitleRoot as BasePolymorphic<"p", BaseRowTitleProps>;

// Replaces the uppercase 11px/600 dimmed labels: `.detail-label` in DetailField,
// PlatformAssetCard and CustomCardPrintFlowJobCard, `.cell-label` in OrderLineItemCard,
// `.column-header-label`/`.section-label` in OrderCard, `.column-header-label` in StorefrontCard
// and `.label` in customerDetailFields.
export type BaseDetailLabelProps = TextProps;
function BaseDetailLabelRoot({
  className, ...others 
}: BaseDetailLabelProps) {
  return (<Text
    {...others} className={joinClassNames(classes["detail-label"],
      className)}
  />);
}
export const BaseDetailLabel = BaseDetailLabelRoot as BasePolymorphic<"p", BaseDetailLabelProps>;

// Replaces `.detail-value` in DetailField, PlatformAssetCard and CustomCardPrintFlowJobCard;
// close to `.cell-value` in OrderLineItemCard and `.value` in customerDetailFields.
export type BaseDetailValueProps = TextProps;
function BaseDetailValueRoot({
  className, ...others 
}: BaseDetailValueProps) {
  return (<Text
    {...others} className={joinClassNames(classes["detail-value"],
      className)}
  />);
}
export const BaseDetailValue = BaseDetailValueRoot as BasePolymorphic<"p", BaseDetailValueProps>;

// Replaces `.ledger-row`, `.ledger-row-total`, `.ledger-label` and `.ledger-value` in
// OrderPaymentCard and OrderPlatformFeeCard. Forwards ref and DOM props, so it can be a Tooltip child.
export interface BaseLedgerRowProps extends BoxProps, ElementProps<"div"> {
  label: ReactNode;
  value: ReactNode;
  total?: boolean;
}
export function BaseLedgerRow({
  label, value, total = false, className, mod, ...others
}: BaseLedgerRowProps) {
  return (
    <Box
      {...others} mod={[
        { total },
        mod,
      ]} className={joinClassNames(classes["ledger-row"],
        className)}
    >
      <Text className={classes["ledger-label"]}>{label}</Text>
      <Text className={classes["ledger-value"]}>{value}</Text>
    </Box>
  );
}

// Page layout roles (ENG-6355, the table lab page): every screen wrapper renders its body in
// BasePageBody and its title block in BasePageHeader > BasePageTitle + BasePageDescription.
export type BasePageBodyProps = BoxProps & ElementProps<"div">;
export function BasePageBody({
  className, ...others
}: BasePageBodyProps) {
  return (<Box
    {...others} className={joinClassNames(classes["page-body"],
      className)}
  />);
}

export type BasePageHeaderProps = BoxProps & ElementProps<"div">;
export function BasePageHeader({
  className, ...others
}: BasePageHeaderProps) {
  return (<Box
    {...others} className={joinClassNames(classes["page-header"],
      className)}
  />);
}

// The page h1 (unstyled Title order 1). Margin 0; spacing comes from BasePageHeader.
export type BasePageTitleProps = Omit<TitleProps, "unstyled">;
export function BasePageTitle({
  className, order = 1, ...others
}: BasePageTitleProps) {
  return (
    <Title
      {...others} order={order} unstyled className={joinClassNames(classes["page-title"],
        className)}
    />
  );
}

// The muted line under BasePageTitle.
export type BasePageDescriptionProps = TextProps;
function BasePageDescriptionRoot({
  className, ...others
}: BasePageDescriptionProps) {
  return (<Text
    {...others} className={joinClassNames(classes["page-description"],
      className)}
  />);
}
export const BasePageDescription = BasePageDescriptionRoot as BasePolymorphic<"p", BasePageDescriptionProps>;
