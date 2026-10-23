"use client";

import dynamic from "next/dynamic";
import React, { ComponentProps } from "react";

function MapSkeleton() {
  return (
    <div className="relative w-full h-[600px] min-h-[500px] bg-slate-900 rounded-2xl overflow-hidden border border-slate-800 shadow-2xl flex flex-col items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 border-4 border-cyan-500/20 border-t-cyan-500 rounded-full animate-spin" />
        <p className="text-slate-400 text-sm font-medium tracking-wide">
          Initializing Geospatial Engine &amp; PostGIS Layer...
        </p>
      </div>
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950/60 to-transparent pointer-events-none" />
    </div>
  );
}

const DisasterMap = dynamic(() => import("./DisasterMap"), {
  ssr: false,
  loading: () => <MapSkeleton />,
});

export type MapWrapperProps = ComponentProps<typeof DisasterMap>;

export default function MapWrapper(props: MapWrapperProps) {
  return <DisasterMap {...(props as any)} />;
}