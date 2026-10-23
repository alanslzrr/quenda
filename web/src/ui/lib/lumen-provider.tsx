"use client";


import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type AnchorHTMLAttributes,
  type ComponentType,
  type ImgHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";


export interface LumenLinkProps
  extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  ref?: Ref<HTMLAnchorElement>;
}


export interface LumenImageProps
  extends Omit<
    ImgHTMLAttributes<HTMLImageElement>,
    "src" | "alt" | "width" | "height" | "loading" | "srcSet"
  > {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  
  fill?: boolean;
  
  priority?: boolean;
  loading?: "eager" | "lazy";
  ref?: Ref<HTMLImageElement>;
}

export type LumenLinkComponent = ComponentType<LumenLinkProps>;
export type LumenImageComponent = ComponentType<LumenImageProps>;


export function LumenAnchor(props: LumenLinkProps) {
  return <a {...props} />;
}

const fillStyle = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
} as const;


export function LumenImg({
  alt,
  fill,
  priority,
  loading,
  style,
  ...props
}: LumenImageProps) {
  // eslint-disable-next-line @next/next/no-img-element -- the framework-free default; pass next/image through LumenProvider instead.
  return (
    <img
      alt={alt}
      decoding="async"
      {...props}
      loading={loading ?? (priority ? "eager" : "lazy")}
      fetchPriority={priority ? "high" : props.fetchPriority}
      style={fill ? { ...fillStyle, ...style } : style}
    />
  );
}

interface LumenComponents {
  link: LumenLinkComponent;
  image: LumenImageComponent;
}

const LumenContext = createContext<LumenComponents>({
  link: LumenAnchor,
  image: LumenImg,
});

export interface LumenProviderProps {
  
  link?: LumenLinkComponent;
  
  image?: LumenImageComponent;
  children: ReactNode;
}


export function LumenProvider({ link, image, children }: LumenProviderProps) {
  const parent = useContext(LumenContext);
  const value = useMemo(
    () => ({ link: link ?? parent.link, image: image ?? parent.image }),
    [link, image, parent],
  );
  return (
    <LumenContext.Provider value={value}>{children}</LumenContext.Provider>
  );
}


export const useLumenLink = () => useContext(LumenContext).link;

export const useLumenImage = () => useContext(LumenContext).image;


export function LumenLink(props: LumenLinkProps) {
  return createElement(useLumenLink(), props);
}


export function LumenImage(props: LumenImageProps) {
  return createElement(useLumenImage(), props);
}
