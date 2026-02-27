import React, { useState, useCallback, useRef } from 'react';
import { Upload, FileText, Download, Sliders, CheckCircle, AlertCircle, Loader2, X } from 'lucide-react';
import { motion, Reorder } from 'framer-motion';
import { PDFDocument, PDFRawStream, PDFName } from 'pdf-lib';
import './App.css';

// --- Types ---
type AppMode = 'compress' | 'convert';
type CompressionLevel = 'low' | 'medium' | 'high';

interface FileStatus {
  file: File;
  compressedBlob: Blob | null;
  status: 'idle' | 'compressing' | 'completed' | 'error';
  originalSize: number;
  compressedSize: number | null;
  error?: string;
}

interface ImageItem {
  id: string;
  file: File;
  preview: string;
}

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('compress');
  const [fileStatus, setFileStatus] = useState<FileStatus | null>(null);
  const [compressionLevel, setCompressionLevel] = useState<CompressionLevel>('medium');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Image to PDF states
  const [imageList, setImageList] = useState<ImageItem[]>([]);
  const [isConverting, setIsConverting] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // --- Helper: Aggressive Image Compression using Canvas ---
  const reencodeImage = async (
    imageBytes: Uint8Array,
    scale: number,
    quality: number
  ): Promise<Uint8Array | null> => {
    return new Promise((resolve) => {
      const blob = new Blob([imageBytes.buffer as ArrayBuffer]);
      const url = URL.createObjectURL(blob);
      const img = new Image();

      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;

        canvas.width = Math.max(1, img.width * scale);
        canvas.height = Math.max(1, img.height * scale);

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        canvas.toBlob((resultBlob) => {
          if (resultBlob) {
            resultBlob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
          } else {
            resolve(null);
          }
        }, 'image/jpeg', quality);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };

      img.src = url;
    });
  };

  // --- Advanced PDF Compression Logic ---
  const compressPDF = async (file: File, level: CompressionLevel) => {
    setFileStatus({
      file,
      compressedBlob: null,
      status: 'compressing',
      originalSize: file.size,
      compressedSize: null
    });

    try {
      const arrayBuffer = await file.arrayBuffer();

      // Memory insight: Load with ignoreEncryption to save space if decryption isn't needed
      const pdfDoc = await PDFDocument.load(arrayBuffer, {
        ignoreEncryption: true,
        throwOnInvalidObject: false
      });

      // Aggressive config
      const config = {
        low: { quality: 0.7, scale: 0.8 },
        medium: { quality: 0.4, scale: 0.6 },
        high: { quality: 0.1, scale: 0.4 }
      }[level];

      // --- NEW: Structural & Metadata Optimization ---
      // 1. Clear standard metadata
      pdfDoc.setTitle('');
      pdfDoc.setAuthor('');
      pdfDoc.setSubject('');
      pdfDoc.setKeywords([]);
      pdfDoc.setCreator('');
      pdfDoc.setProducer('');
      pdfDoc.setCreationDate(new Date(0));
      pdfDoc.setModificationDate(new Date(0));

      // 2. Prune Catalog (Remove XMP Metadata and Accessibility Tags)
      const catalog = pdfDoc.catalog;
      catalog.delete(PDFName.of('Metadata'));
      catalog.delete(PDFName.of('StructTreeRoot'));
      catalog.delete(PDFName.of('PieceInfo'));
      catalog.delete(PDFName.of('OCProperties')); // Layers data

      // 3. Prune Page-level private data
      const pages = pdfDoc.getPages();
      pages.forEach(page => {
        page.node.delete(PDFName.of('PieceInfo'));
        page.node.delete(PDFName.of('Metadata'));
      });
      // --- END NEW ---

      const indirectObjects = pdfDoc.context.enumerateIndirectObjects();

      for (const [ref, obj] of indirectObjects) {
        if (obj instanceof PDFRawStream) {
          const dict = obj.dict;
          const subtype = dict.get(PDFName.of('Subtype'));

          if (subtype === PDFName.of('Image')) {
            try {
              const currentBytes = obj.getContents();
              const compressedBytes = await reencodeImage(
                currentBytes,
                config.scale,
                config.quality
              );

              if (compressedBytes && compressedBytes.length < currentBytes.length) {
                // Update dictionary and content
                dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
                // Length is automatically updated by pdf-lib on save

                // Replace the stream object in the context
                const newStream = PDFRawStream.of(dict, compressedBytes);
                pdfDoc.context.assign(ref, newStream);
              }
            } catch (e) {
              console.warn('Failed to compress an image stream, skipping...', e);
            }
          }
        }
      }

      const useObjectStreams = level !== 'low';

      const compressedBytes = await pdfDoc.save({
        useObjectStreams,
        addDefaultPage: false,
        updateFieldAppearances: false
      });

      // Fix Type Error: Use a proper type assertion
      const blob = new Blob([compressedBytes.buffer as ArrayBuffer], { type: 'application/pdf' });

      await new Promise(resolve => setTimeout(resolve, 500));

      setFileStatus(prev => prev ? {
        ...prev,
        status: 'completed',
        compressedBlob: blob,
        compressedSize: blob.size
      } : null);
    } catch (err) {
      console.error('Compression Error:', err);
      let errorMessage = 'Failed to compress PDF. Please try again.';

      if (err instanceof RangeError || (err as any).message?.includes('memory')) {
        errorMessage = 'File is too large for browser memory. Try a smaller file.';
      } else if ((err as any).message?.includes('password') || (err as any).message?.includes('encrypted')) {
        errorMessage = 'This PDF is password protected and cannot be compressed.';
      }

      setFileStatus(prev => prev ? {
        ...prev,
        status: 'error',
        error: errorMessage
      } : null);
    }
  };

  // --- Image to PDF Logic ---
  const onImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newImages = files.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      file,
      preview: URL.createObjectURL(file)
    }));
    setImageList(prev => [...prev, ...newImages]);
  };

  const removeImage = (id: string) => {
    setImageList(prev => {
      const filtered = prev.filter(img => img.id !== id);
      const removed = prev.find(img => img.id === id);
      if (removed) URL.revokeObjectURL(removed.preview);
      return filtered;
    });
  };

  const generatePDFFromImages = async () => {
    if (imageList.length === 0) return;
    setIsConverting(true);

    try {
      const pdfDoc = await PDFDocument.create();

      for (const item of imageList) {
        const imageBytes = await item.file.arrayBuffer();
        let image;
        if (item.file.type === 'image/jpeg' || item.file.type === 'image/jpg') {
          image = await pdfDoc.embedJpg(imageBytes);
        } else if (item.file.type === 'image/png') {
          image = await pdfDoc.embedPng(imageBytes);
        } else {
          continue;
        }

        const { width, height } = image.scale(1);
        const page = pdfDoc.addPage([width, height]);
        page.drawImage(image, { x: 0, y: 0, width, height });
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'images_combined.pdf';
      a.click();
      URL.revokeObjectURL(url);

      // Artificial delay
      await new Promise(resolve => setTimeout(resolve, 800));
    } catch (err) {
      console.error('Conversion Error:', err);
      alert('Failed to generate PDF. Please check your image formats.');
    } finally {
      setIsConverting(false);
    }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);

    if (mode === 'compress') {
      const file = files[0];
      if (file && file.type === 'application/pdf') {
        compressPDF(file, compressionLevel);
      }
    } else {
      const imageFiles = files.filter(f => f.type.startsWith('image/'));
      const newImages = imageFiles.map(file => ({
        id: Math.random().toString(36).substr(2, 9),
        file,
        preview: URL.createObjectURL(file)
      }));
      setImageList(prev => [...prev, ...newImages]);
    }
  }, [mode, compressionLevel]);

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      compressPDF(file, compressionLevel);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getCompressionInfo = (level: CompressionLevel) => {
    switch (level) {
      case 'low': return 'High Quality / Large Size';
      case 'medium': return 'Balanced Quality / Small Size';
      case 'high': return 'Low Quality / Smallest Size';
    }
  };

  return (
    <div className="app-container">
      <nav className="navbar">
        <div className="logo" onClick={() => window.location.reload()}>
          <FileText className="logo-icon" />
          <span>CentrivixPDF</span>
        </div>
        <div className="mode-switcher glass-card">
          <button
            className={`mode-btn ${mode === 'compress' ? 'active' : ''}`}
            onClick={() => {
              setMode('compress');
              setFileStatus(null); // Clear compressor state when switching
              setImageList([]); // Clear image list when switching
            }}
          >
            Compressor
          </button>
          <button
            className={`mode-btn ${mode === 'convert' ? 'active' : ''}`}
            onClick={() => {
              setMode('convert');
              setFileStatus(null); // Clear compressor state when switching
              setImageList([]); // Clear image list when switching
            }}
          >
            Image to PDF
          </button>
        </div>
      </nav>

      <main className="main-content">
        <section className="hero">
          <motion.h1
            key={mode}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            {mode === 'compress' ? (
              <>Compress PDF with <span className="gradient-text">Zero Compromise</span></>
            ) : (
              <>Turn Images into <span className="gradient-text">Beautiful PDFs</span></>
            )}
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            {mode === 'compress'
              ? 'Highest quality compression, entirely in your browser. Private, fast, and free.'
              : 'Batch convert JPG and PNG images. Reorder effortlessly. Completely secure.'}
          </motion.p>
        </section>

        <section className="tool-section">
          {mode === 'compress' ? (
            /* COMPRESSOR TAB */
            <>
              {!fileStatus || fileStatus.status === 'idle' ? (
                <motion.div
                  className={`upload-zone glass-card ${isDragging ? 'dragging' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={onDrop}
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={onFileSelect}
                    accept="application/pdf"
                    hidden
                  />
                  <div className="upload-content">
                    <div className="icon-wrapper">
                      <Upload className="upload-icon" />
                    </div>
                    <h3>Click or drag PDF here</h3>
                    <p>Maximum file size: 50MB</p>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  className="processing-zone glass-card"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                >
                  <div className="file-info-header">
                    <FileText className="file-icon" />
                    <div className="file-details">
                      <span className="file-name">{fileStatus.file.name}</span>
                      <span className="file-size">{formatSize(fileStatus.originalSize)}</span>
                    </div>
                    <button className="btn-close" onClick={() => setFileStatus(null)}>
                      <X size={20} />
                    </button>
                  </div>

                  <div className="divider"></div>

                  {fileStatus.status === 'compressing' && (
                    <div className="processing-state">
                      <Loader2 className="spinner" />
                      <p>Compressing your PDF...</p>
                    </div>
                  )}

                  {fileStatus.status === 'completed' && (
                    <div className="completed-state">
                      <div className="stats-row">
                        <div className="stat">
                          <span className="stat-label">Original</span>
                          <span className="stat-value">{formatSize(fileStatus.originalSize)}</span>
                        </div>
                        <div className="stat-arrow">→</div>
                        <div className="stat highlight">
                          <span className="stat-label">Compressed</span>
                          <span className="stat-value">{formatSize(fileStatus.compressedSize!)}</span>
                        </div>
                        <div className="saving-badge">
                          {Math.round((1 - (fileStatus.compressedSize! / fileStatus.originalSize)) * 100)}% Smaller
                        </div>
                      </div>

                      <button
                        className="btn btn-primary btn-block"
                        onClick={() => {
                          if (!fileStatus.compressedBlob) return;
                          const url = URL.createObjectURL(fileStatus.compressedBlob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `compressed_${fileStatus.file.name}`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                      >
                        <Download size={20} />
                        Download Compressed PDF
                      </button>
                    </div>
                  )}

                  {fileStatus.status === 'error' && (
                    <div className="error-state">
                      <AlertCircle className="error-icon" />
                      <p>{fileStatus.error}</p>
                      <button className="btn btn-secondary" onClick={() => setFileStatus(null)}>Try Again</button>
                    </div>
                  )}
                </motion.div>
              )}

              <div className="settings-panel glass-card">
                <div className="settings-header">
                  <Sliders size={20} />
                  <span>Compression Settings</span>
                </div>
                <div className="compression-options">
                  {(['low', 'medium', 'high'] as CompressionLevel[]).map((level) => (
                    <button
                      key={level}
                      className={`level-btn ${compressionLevel === level ? 'active' : ''}`}
                      onClick={() => setCompressionLevel(level)}
                    >
                      <span className="level-title">{level.charAt(0).toUpperCase() + level.slice(1)}</span>
                      <span className="level-desc">{getCompressionInfo(level)}</span>
                      {compressionLevel === level && <CheckCircle className="check-icon" size={16} />}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            /* CONVERTER TAB */
            <div className="converter-container">
              {imageList.length === 0 ? (
                <motion.div
                  className={`upload-zone glass-card ${isDragging ? 'dragging' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={onDrop}
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => imageInputRef.current?.click()}
                >
                  <input
                    type="file"
                    ref={imageInputRef}
                    onChange={onImageSelect}
                    accept="image/jpeg,image/png"
                    multiple
                    hidden
                  />
                  <div className="upload-content">
                    <div className="icon-wrapper">
                      <Upload className="upload-icon" />
                    </div>
                    <h3>Drop images here</h3>
                    <p>JPG and PNG supported</p>
                  </div>
                </motion.div>
              ) : (
                <div className="image-list-container">
                  <Reorder.Group
                    axis="y"
                    values={imageList}
                    onReorder={setImageList}
                    className="image-reorder-list"
                  >
                    {imageList.map((item) => (
                      <Reorder.Item
                        key={item.id}
                        value={item}
                        className="image-item glass-card"
                      >
                        <div className="drag-handle">⋮⋮</div>
                        <img src={item.preview} alt="preview" className="img-preview" />
                        <span className="img-filename">{item.file.name}</span>
                        <button className="btn-remove" onClick={() => removeImage(item.id)}>
                          <X size={16} />
                        </button>
                      </Reorder.Item>
                    ))}
                  </Reorder.Group>

                  <div className="converter-actions glass-card">
                    <div className="action-info">
                      <strong>{imageList.length}</strong> {imageList.length === 1 ? 'image' : 'images'} selected
                    </div>
                    <div className="btn-group">
                      <button className="btn btn-secondary" onClick={() => imageInputRef.current?.click()}>
                        Add More
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={isConverting}
                        onClick={generatePDFFromImages}
                      >
                        {isConverting ? (
                          <><Loader2 className="spinner" size={16} /> Generating...</>
                        ) : (
                          <><Download size={16} /> Convert to PDF</>
                        )}
                      </button>
                      <input
                        type="file"
                        ref={imageInputRef}
                        onChange={onImageSelect}
                        accept="image/jpeg,image/png"
                        multiple
                        hidden
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        <p>© 2026 CentrivixPDF. No files are uploaded to our servers.</p>
      </footer>
    </div>
  );
};

export default App;
